/**
 * CliRenderer: turns a stream of CliRendererEvents into a coherent,
 * rate-limited, CLI-style message flow on any post/edit-capable
 * channel (Telegram bot API being the first consumer).
 *
 * UX shape per run:
 *   1. On `start`: post ONE message.
 *        [🟡] Claude is working... (0s)
 *        <small hint if provided>
 *   2. Heartbeat (every heartbeatIntervalMs, cycling spinner frame,
 *      updating elapsed seconds, rate-limited by editRateLimitMs):
 *        [🟠] Claude is working... (12s)
 *        🔧 Read src/foo.ts
 *        🔧 Edit src/foo.ts (+3/-1)
 *        ...
 *   3. On `tool-call` / `tool-result` / `thinking` / `text-delta`:
 *      append to the activity buffer (bounded window) and schedule
 *      an edit. Rate limiter coalesces rapid events.
 *   4. On `complete`: stop heartbeat, edit the message to the final
 *      rendered text (via options.renderFinal). If the final exceeds
 *      channel limits, split and post additional messages.
 *   5. On `error`: stop heartbeat, edit the message to an error
 *      indicator with the error text.
 *
 * Properties guaranteed:
 *   - Never exceeds editRateLimitMs rate (coalesces queued updates).
 *   - Heartbeat fires only while a message is posted AND not completed.
 *   - dispose() is idempotent; safe to call in a finally block.
 *   - Errors in channel.post / channel.edit are caught and logged; the
 *     renderer continues (best-effort rendering is better than crashing
 *     the caller on a transient Telegram outage).
 */
const DEFAULT_SPINNER = ['🟡', '🟠', '🔴', '🟣', '🔵', '🟢'];
const DEFAULT_EDIT_RATE_MS = 1500;
const DEFAULT_HEARTBEAT_MS = 3000;
const DEFAULT_ACTIVITY_WINDOW = 8;
const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_LIVE_PREVIEW_MAX_CHARS = 220;
const DEFAULT_LIVE_PREVIEW_LINES = 4;
export class CliRenderer {
    channel;
    now;
    editRateLimitMs;
    heartbeatIntervalMs;
    spinnerFrames;
    activityWindow;
    renderFinal;
    splitFinal;
    action;
    livePreviewMaxChars;
    livePreviewLines;
    messageId = null;
    startedAtMs = 0;
    lastEditMs = 0;
    spinnerIdx = 0;
    label = 'Working';
    hint;
    activity = [];
    accumulatedText = '';
    thinkingBuffer = '';
    heartbeatHandle = null;
    pendingEditTimer = null;
    completed = false;
    disposed = false;
    constructor(options) {
        this.channel = options.channel;
        this.now = options.now ?? (() => Date.now());
        this.editRateLimitMs = options.editRateLimitMs ?? DEFAULT_EDIT_RATE_MS;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
        this.spinnerFrames = options.spinnerFrames ?? DEFAULT_SPINNER;
        this.activityWindow = options.activityWindow ?? DEFAULT_ACTIVITY_WINDOW;
        this.renderFinal = options.renderFinal ?? ((s) => s);
        this.splitFinal = options.splitFinal ?? defaultSplit;
        this.action = options.action ?? null;
        this.livePreviewMaxChars = options.livePreviewMaxChars ?? DEFAULT_LIVE_PREVIEW_MAX_CHARS;
        this.livePreviewLines = options.livePreviewLines ?? DEFAULT_LIVE_PREVIEW_LINES;
    }
    /**
     * Feed an event. Returns after any immediate edit (rate-limiter
     * permitting) so callers can sequence events without awaiting internal
     * timers. Returns even if the channel call fails (errors are logged).
     */
    async emit(event) {
        if (this.disposed)
            return;
        switch (event.type) {
            case 'start':
                await this.handleStart(event.label, event.hint);
                return;
            case 'tool-call':
                this.appendActivity('🔧', `${event.tool}: ${truncate(event.summary, 60)}`);
                this.scheduleEdit();
                return;
            case 'tool-result':
                this.appendActivity(event.ok ? '✓' : '✗', event.summary ? `${event.tool}: ${truncate(event.summary, 60)}` : event.tool);
                this.scheduleEdit();
                return;
            case 'thinking':
                this.thinkingBuffer = this.thinkingBuffer
                    ? this.thinkingBuffer + '\n' + event.text
                    : event.text;
                // Surface thinking live in the throbber so the operator sees
                // the model's reasoning arc. It's NEVER embedded into the
                // final message (long thinking blocks would bust Telegram's
                // 4096-char split or render as noise after the answer).
                this.scheduleEdit();
                return;
            case 'text-delta':
                this.accumulatedText += event.text;
                // Live preview: show the tail of what Claude has typed so the
                // operator sees what's in flight, not just tool calls.
                this.scheduleEdit();
                return;
            case 'complete':
                await this.handleComplete(event.finalText, event.meta);
                return;
            case 'error':
                await this.handleError(event.message);
                return;
        }
    }
    /**
     * Stop the heartbeat and release any pending edit timer. Safe to
     * call multiple times. Does NOT edit the message; call this from
     * finally after emitting a terminal event.
     */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.stopHeartbeat();
        if (this.pendingEditTimer) {
            clearTimeout(this.pendingEditTimer);
            this.pendingEditTimer = null;
        }
    }
    async handleStart(label, hint) {
        if (this.messageId !== null)
            return;
        if (label)
            this.label = label;
        if (hint !== undefined)
            this.hint = hint;
        this.startedAtMs = this.now();
        const body = this.renderProgress();
        try {
            const posted = await this.channel.post({
                text: body,
                parseMode: 'HTML',
                disableNotification: true,
                ...(this.action ? { actions: [this.action] } : {}),
            });
            this.messageId = posted.messageId;
            this.lastEditMs = this.now();
            this.startHeartbeat();
        }
        catch (err) {
            logChannelError('post', err);
        }
    }
    async handleComplete(finalText, meta) {
        // Parser + daemon may both emit `complete`. Idempotent-guard so the
        // second one doesn't re-edit the message.
        if (this.completed)
            return;
        this.completed = true;
        this.stopHeartbeat();
        if (this.pendingEditTimer) {
            clearTimeout(this.pendingEditTimer);
            this.pendingEditTimer = null;
        }
        // Thinking is surfaced live in the throbber only; it never lands in
        // the final message (long thinking blocks cause split-at-HTML-tag
        // corruption or render as noise after the answer).
        const footer = this.renderFooter(meta);
        const composed = footer ? `${finalText}\n\n${footer}` : finalText;
        const rendered = this.renderFinal(composed);
        const chunks = this.splitFinal(rendered);
        if (chunks.length === 0)
            return;
        if (this.messageId === null) {
            // start never got called or failed; post the final directly.
            try {
                const posted = await this.channel.post({ text: chunks[0], parseMode: 'HTML' });
                this.messageId = posted.messageId;
            }
            catch (err) {
                logChannelError('post', err);
                return;
            }
        }
        else {
            try {
                await this.channel.edit(this.messageId, {
                    text: chunks[0],
                    parseMode: 'HTML',
                    // Clear the action button on the terminal edit; without this
                    // Telegram keeps the Stop button attached to the final reply.
                    ...(this.action ? { actions: [] } : {}),
                });
            }
            catch (err) {
                logChannelError('edit', err);
            }
        }
        for (let i = 1; i < chunks.length; i++) {
            try {
                await this.channel.post({ text: chunks[i], parseMode: 'HTML' });
            }
            catch (err) {
                logChannelError('post', err);
            }
        }
    }
    async handleError(message) {
        this.completed = true;
        this.stopHeartbeat();
        const text = `<b>⚠️ Error</b>\n\n${escapeHtml(message)}`;
        if (this.messageId === null) {
            try {
                await this.channel.post({ text, parseMode: 'HTML' });
            }
            catch (err) {
                logChannelError('post', err);
            }
            return;
        }
        try {
            await this.channel.edit(this.messageId, {
                text,
                parseMode: 'HTML',
                // Clear the Stop button on a terminal error edit.
                ...(this.action ? { actions: [] } : {}),
            });
        }
        catch (err) {
            logChannelError('edit', err);
        }
    }
    startHeartbeat() {
        if (this.heartbeatHandle !== null)
            return;
        this.heartbeatHandle = setInterval(() => {
            if (this.completed || this.disposed) {
                this.stopHeartbeat();
                return;
            }
            this.spinnerIdx = (this.spinnerIdx + 1) % this.spinnerFrames.length;
            this.scheduleEdit();
        }, this.heartbeatIntervalMs);
        // Don't hold the event loop open on heartbeats alone.
        if (typeof this.heartbeatHandle.unref === 'function') {
            this.heartbeatHandle.unref();
        }
    }
    stopHeartbeat() {
        if (this.heartbeatHandle === null)
            return;
        clearInterval(this.heartbeatHandle);
        this.heartbeatHandle = null;
    }
    scheduleEdit() {
        if (this.messageId === null || this.completed || this.disposed)
            return;
        const elapsed = this.now() - this.lastEditMs;
        if (elapsed >= this.editRateLimitMs) {
            void this.flushEdit();
            return;
        }
        if (this.pendingEditTimer !== null)
            return;
        this.pendingEditTimer = setTimeout(() => {
            this.pendingEditTimer = null;
            void this.flushEdit();
        }, this.editRateLimitMs - elapsed);
        if (typeof this.pendingEditTimer.unref === 'function') {
            this.pendingEditTimer.unref();
        }
    }
    async flushEdit() {
        if (this.messageId === null || this.completed || this.disposed)
            return;
        const body = this.renderProgress();
        this.lastEditMs = this.now();
        try {
            await this.channel.edit(this.messageId, {
                text: body,
                parseMode: 'HTML',
                disableNotification: true,
                // Telegram's editMessageText strips reply_markup when the field
                // is omitted; we must re-send the action on every intermediate
                // edit to keep the Stop button visible until a terminal state.
                ...(this.action ? { actions: [this.action] } : {}),
            });
        }
        catch (err) {
            logChannelError('edit', err);
        }
    }
    appendActivity(icon, text) {
        this.activity.push({ icon, text });
        if (this.activity.length > this.activityWindow) {
            this.activity.splice(0, this.activity.length - this.activityWindow);
        }
    }
    renderProgress() {
        const frame = this.spinnerFrames[this.spinnerIdx];
        const elapsedSec = Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1000));
        const head = `${frame} ${escapeHtml(this.label)}... (${elapsedSec}s)`;
        const hintLine = this.hint ? `\n<i>${escapeHtml(this.hint)}</i>` : '';
        const activityLines = this.activity.length === 0
            ? ''
            : '\n\n' + this.activity.map((a) => `${a.icon} ${escapeHtml(a.text)}`).join('\n');
        const thinking = this.renderLiveThinking();
        const thinkingBlock = thinking.length === 0 ? '' : `\n\n${thinking}`;
        const preview = this.renderLivePreview();
        const previewBlock = preview.length === 0 ? '' : `\n\n${preview}`;
        return head + hintLine + activityLines + thinkingBlock + previewBlock;
    }
    /**
     * Render the tail of accumulated assistant text as a blockquote so
     * the operator sees what Claude is typing. Returns empty string when
     * there's nothing to preview or previews are disabled.
     */
    renderLivePreview() {
        if (this.livePreviewMaxChars <= 0 || this.livePreviewLines <= 0)
            return '';
        const raw = this.accumulatedText.trimEnd();
        if (raw.length === 0)
            return '';
        const lines = raw.split('\n');
        const tail = lines.slice(-this.livePreviewLines).join('\n');
        const clipped = tail.length <= this.livePreviewMaxChars
            ? tail
            : '…' + tail.slice(tail.length - this.livePreviewMaxChars + 1);
        return `<blockquote>${escapeHtml(clipped)}</blockquote>`;
    }
    /**
     * Render the tail of accumulated thinking as a compact italic block
     * prefixed with a 💭. Thinking shows only while the turn is live; it
     * never enters the final message (see handleComplete).
     */
    renderLiveThinking() {
        if (this.livePreviewMaxChars <= 0)
            return '';
        const raw = this.thinkingBuffer.trimEnd();
        if (raw.length === 0)
            return '';
        const lines = raw.split('\n');
        const tailLines = Math.max(1, Math.min(this.livePreviewLines, 3));
        const tail = lines.slice(-tailLines).join(' ');
        const maxThinkingChars = Math.min(this.livePreviewMaxChars, 180);
        const clipped = tail.length <= maxThinkingChars
            ? tail
            : '…' + tail.slice(tail.length - maxThinkingChars + 1);
        return `💭 <i>${escapeHtml(clipped)}</i>`;
    }
    renderFooter(meta) {
        if (!meta || Object.keys(meta).length === 0)
            return '';
        const parts = Object.entries(meta).map(([k, v]) => `${k}=${String(v)}`);
        // Emit as markdown italic, not literal HTML. When renderFinal is a
        // markdown->HTML converter (TelegramHtml), raw `<i>` tags would be
        // escaped to `&lt;i&gt;` by the converter's free-text escape pass.
        // `_..._` lets the converter produce the `<i>` tag itself.
        return `_${parts.join(' · ')}_`;
    }
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 1) + '…';
}
function escapeHtml(s) {
    return s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function defaultSplit(text) {
    if (text.length <= DEFAULT_MAX_CHARS)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > DEFAULT_MAX_CHARS) {
        // Prefer breaking at the last newline before the limit.
        const slice = remaining.slice(0, DEFAULT_MAX_CHARS);
        const lastBreak = slice.lastIndexOf('\n\n');
        const cut = lastBreak > DEFAULT_MAX_CHARS * 0.5 ? lastBreak : DEFAULT_MAX_CHARS;
        chunks.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut).replace(/^\n+/, '');
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
function logChannelError(op, err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[cli-renderer] channel.${op} failed: ${msg}`);
}
//# sourceMappingURL=renderer.js.map