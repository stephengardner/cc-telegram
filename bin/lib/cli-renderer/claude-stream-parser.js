/**
 * Parse Claude CLI's `--output-format stream-json --verbose` output
 * into CliRendererEvents.
 *
 * Contract: each line of stdout is one JSON object. We return zero,
 * one, or multiple events per line depending on the shape (a single
 * assistant message can carry multiple content blocks; each block
 * maps to a distinct event).
 *
 * Defensive parsing: we only extract fields we understand and ignore
 * everything else, so a future Claude CLI schema addition does not
 * break the renderer -- it just stops surfacing the new field until
 * this parser catches up.
 */
export function emptyAccumulator() {
    return { assistantText: '', thinkingText: '', meta: {} };
}
/**
 * Parse one JSONL line into zero or more CliRendererEvents, mutating
 * the accumulator for ongoing run state. Malformed lines are logged
 * to stderr but do not throw.
 */
export function parseClaudeStreamLine(line, acc) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        // eslint-disable-next-line no-console
        console.error('[claude-stream-parser] non-JSON line ignored:', trimmed.slice(0, 120));
        return [];
    }
    if (!isRecord(parsed))
        return [];
    const type = parsed.type;
    if (typeof type !== 'string')
        return [];
    switch (type) {
        case 'system':
            // Claude CLI emits system/init at session start. We don't
            // surface it beyond the start event the caller already sent.
            return [];
        case 'assistant':
            return parseAssistantMessage(parsed, acc);
        case 'user':
            return parseUserMessage(parsed);
        case 'result':
            return parseResultMessage(parsed, acc);
        default:
            return [];
    }
}
function parseAssistantMessage(envelope, acc) {
    const message = pickRecord(envelope.message);
    if (!message)
        return [];
    const content = message.content;
    if (!Array.isArray(content))
        return [];
    const events = [];
    for (const block of content) {
        if (!isRecord(block))
            continue;
        const bType = block.type;
        if (bType === 'text' && typeof block.text === 'string') {
            acc.assistantText += block.text;
            events.push({ type: 'text-delta', text: block.text });
            continue;
        }
        if (bType === 'thinking' && typeof block.thinking === 'string') {
            acc.thinkingText += acc.thinkingText.length === 0
                ? block.thinking
                : '\n' + block.thinking;
            events.push({ type: 'thinking', text: block.thinking });
            continue;
        }
        if (bType === 'tool_use' && typeof block.name === 'string') {
            events.push({
                type: 'tool-call',
                tool: block.name,
                summary: summarizeToolUse(block.name, pickRecord(block.input) ?? {}),
            });
            continue;
        }
    }
    return events;
}
function parseUserMessage(envelope) {
    const message = pickRecord(envelope.message);
    if (!message)
        return [];
    const content = message.content;
    if (!Array.isArray(content))
        return [];
    const events = [];
    for (const block of content) {
        if (!isRecord(block))
            continue;
        if (block.type !== 'tool_result')
            continue;
        const isError = block.is_error === true;
        const tool = typeof block.tool_use_id === 'string'
            ? '' // tool name isn't on the result; caller can correlate by id if needed
            : '';
        const summary = extractToolResultSummary(block.content);
        events.push({
            type: 'tool-result',
            tool: tool.length === 0 ? 'tool' : tool,
            ok: !isError,
            ...(summary === undefined ? {} : { summary }),
        });
    }
    return events;
}
function parseResultMessage(envelope, acc) {
    // Harvest meta for the final footer.
    if (typeof envelope.cost_usd === 'number') {
        acc.meta.cost = `$${envelope.cost_usd.toFixed(4)}`;
    }
    if (typeof envelope.duration_ms === 'number') {
        acc.meta.elapsed = `${Math.round(envelope.duration_ms / 1000)}s`;
    }
    if (typeof envelope.num_turns === 'number') {
        acc.meta.turns = envelope.num_turns;
    }
    const resultText = typeof envelope.result === 'string' && envelope.result.length > 0
        ? envelope.result
        : acc.assistantText;
    const subtype = envelope.subtype;
    if (subtype === 'error_max_turns' || subtype === 'error') {
        const msg = typeof envelope.error === 'string'
            ? envelope.error
            : `Claude CLI ${String(subtype)}`;
        return [{ type: 'error', message: msg }];
    }
    return [{
            type: 'complete',
            finalText: resultText,
            meta: { ...acc.meta },
        }];
}
/**
 * Produce a compact, one-line summary for a tool_use block. Called
 * with common tool names (Read, Edit, Write, Bash, Grep, Glob, ...)
 * and extracts the most informative field from the input object.
 * Unknown tools fall back to a generic JSON preview.
 */
export function summarizeToolUse(toolName, input) {
    const str = (v) => (typeof v === 'string' ? v : '');
    switch (toolName) {
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
            return str(input.file_path) || str(input.notebook_path) || '(no path)';
        case 'Bash':
            return truncate(str(input.command), 80);
        case 'Grep':
            return `${str(input.pattern)}${input.path ? ' in ' + str(input.path) : ''}`;
        case 'Glob':
            return str(input.pattern) || '(no pattern)';
        case 'WebFetch':
            return str(input.url) || '(no url)';
        case 'WebSearch':
            return truncate(str(input.query), 80);
        case 'Task':
        case 'Agent':
            return truncate(str(input.description) || str(input.prompt), 80);
        default: {
            // Generic: show first string field, or a keys summary.
            for (const [k, v] of Object.entries(input)) {
                if (typeof v === 'string' && v.length > 0) {
                    return `${k}=${truncate(v, 60)}`;
                }
            }
            const keys = Object.keys(input).slice(0, 3).join(',');
            return keys.length > 0 ? `(${keys})` : '(no args)';
        }
    }
}
function extractToolResultSummary(content) {
    if (typeof content === 'string')
        return truncate(firstLine(content), 80);
    if (Array.isArray(content)) {
        for (const block of content) {
            if (isRecord(block) && typeof block.text === 'string') {
                return truncate(firstLine(block.text), 80);
            }
        }
    }
    return undefined;
}
function firstLine(s) {
    const idx = s.indexOf('\n');
    return idx === -1 ? s : s.slice(0, idx);
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return s.slice(0, max - 1) + '…';
}
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pickRecord(v) {
    return isRecord(v) ? v : null;
}
//# sourceMappingURL=claude-stream-parser.js.map