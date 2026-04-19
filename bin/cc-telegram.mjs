#!/usr/bin/env node
/**
 * cc-telegram
 *
 * Bidirectional bridge between Telegram and a live Claude Code TUI
 * session. Spawns `claude` as a PTY child and simultaneously long-
 * polls the Telegram Bot API; incoming chat messages are injected
 * into the child's stdin as if you had typed them, and Claude's
 * turn responses are mirrored back to your Telegram chat. Same
 * session, same jsonl, same flow whether you are at the computer
 * or on your phone.
 *
 * Usage:
 *   node bin/cc-telegram.mjs [--resume-session <id>] [--no-mirror]
 *                            [--claude-args "..."] [--verbose]
 *
 *   # or globally after `npm install -g`:
 *   cc-telegram --resume-session <id>
 *
 * Options:
 *   --resume-session <id>   Resume a specific Claude Code session id.
 *                           Default: launches a fresh session.
 *   --no-mirror             Do not mirror Claude's responses to
 *                           Telegram. (Default: mirror on.)
 *   --claude-args "<args>"  Extra args passed to the `claude` command
 *                           (space-separated, single-quoted).
 *   --verbose               Log poll activity + injection diagnostics.
 *
 * Env (via <cwd>/.env or the shell):
 *   TELEGRAM_BOT_TOKEN      Required. Get via @BotFather.
 *   TELEGRAM_CHAT_ID        Required. Your numeric chat id. Talk to
 *                           the bot once, then fetch
 *                           https://api.telegram.org/bot<TOKEN>/getUpdates
 *                           to find your chat id.
 *
 * Prereqs:
 *   - Node 22 or later.
 *   - `claude` CLI installed and authenticated (`claude /login`).
 *   - node-pty installed (`npm install`).
 *
 * Stop: Ctrl-C. The child `claude` process is killed; the Telegram
 * poller stops.
 */

import { spawn as ptySpawn } from 'node-pty';
import { readFile, readdir, stat, open as openFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Script path layout: <project>/bin/cc-telegram.mjs. PROJECT_ROOT is
// only used for packaging metadata; runtime paths (.env, Claude's cwd,
// session jsonl lookup) all go off CWD so a globally-installed
// `cc-telegram` still behaves like a local launcher.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const CWD = process.cwd();

// ---------------------------------------------------------------------------
// .env loader (shared shape with other scripts).
// ---------------------------------------------------------------------------

async function loadDotEnv() {
  try {
    const text = await readFile(resolve(CWD, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    resumeSessionId: null,
    mirror: true,
    claudeArgs: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeSessionId = argv[++i];
    } else if (a === '--no-mirror') {
      args.mirror = false;
    } else if (a === '--claude-args' && i + 1 < argv.length) {
      args.claudeArgs = argv[++i].split(/\s+/).filter(Boolean);
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: cc-telegram [options]

Bidirectional bridge: Claude Code TUI <-> Telegram.
Incoming Telegram messages inject into the Claude Code stdin;
Claude responses mirror back to Telegram as HTML-formatted chunks.

Options:
  --resume-session <id>   Resume a specific Claude Code session id
  --no-mirror             Do not mirror Claude responses to Telegram (default: on)
  --claude-args "..."     Extra args for claude (space-separated)
  --verbose               Log Telegram poll activity + injection events
  -h, --help              This help`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Telegram long-poller.
// ---------------------------------------------------------------------------

class TelegramInjector {
  constructor({ botToken, chatId, onMessage, onError, verbose }) {
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.onMessage = onMessage;
    this.onError = onError ?? ((err, ctx) => console.error(`[tg] ${ctx}:`, err.message || err));
    this.verbose = !!verbose;
    this.updateOffset = 0;
    this.running = false;
    this.pollTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err, 'pollOnce');
      }
      if (!this.running) return;
      this.pollTimer = setTimeout(loop, 2000);
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=0&limit=50`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`getUpdates: ${json.description ?? 'unknown'}`);
    }
    const updates = json.result ?? [];
    for (const update of updates) {
      if (update.update_id >= this.updateOffset) {
        this.updateOffset = update.update_id + 1;
      }
      const m = update.message;
      if (!m || typeof m.text !== 'string' || m.text.length === 0) continue;
      if (String(m.chat.id) !== this.chatId) continue;
      if (this.verbose) {
        console.error(`[tg] inbound #${m.message_id}: ${m.text.slice(0, 60)}`);
      }
      try {
        await this.onMessage({
          text: m.text,
          messageId: m.message_id,
          date: m.date,
          replyTo: m.reply_to_message?.message_id ?? null,
          fromUsername: m.from?.username ?? null,
        });
      } catch (err) {
        this.onError(err, 'onMessage');
      }
    }
  }

  async sendMessage(text, parseMode = null) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`sendMessage: ${json.description ?? 'unknown'}`);
    }
    return json.result;
  }
}

/**
 * Mirror a markdown-flavored text block to Telegram with proper
 * formatting. Splits the raw markdown on safe boundaries first, then
 * converts each chunk to HTML and sends with parse_mode=HTML so
 * **bold**, `code`, fenced blocks, and links render correctly.
 * Errors in a single chunk do not stop the run.
 */
async function sendMirrorText(injector, text, { verbose = false } = {}) {
  if (!text || text.length === 0) return;
  try {
    for (const chunk of splitMarkdownForTelegram(text, 4000)) {
      const html = markdownToTelegramHtml(chunk);
      await injector.sendMessage(html, 'HTML');
    }
  } catch (err) {
    if (verbose) console.error('[tg] mirror send failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Markdown -> Telegram HTML. Deliberately minimal: handles the subset
// of CommonMark that Claude Code emits (fenced code, inline code,
// bold, italic, links). Everything else passes through as plain text
// after HTML escaping. Telegram's `parse_mode: HTML` supports b, i,
// u, s, code, pre, a, blockquote, and `<pre><code class="language-..">`.
// ---------------------------------------------------------------------------

function escapeHtmlForTelegram(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToTelegramHtml(md) {
  // Step 1: extract fenced code blocks first so their contents are
  // not touched by inline conversions.
  const fenced = [];
  let work = md.replace(/```([\w+.-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fenced.push({ lang, code });
    return `\u0000FENCE${fenced.length - 1}\u0000`;
  });

  // Step 2: extract inline code similarly.
  const inline = [];
  work = work.replace(/`([^`\n]+)`/g, (_, code) => {
    inline.push(code);
    return `\u0000INLINE${inline.length - 1}\u0000`;
  });

  // Step 3: HTML-escape the prose.
  work = escapeHtmlForTelegram(work);

  // Step 4: links [text](url). Text is already escaped; escape url.
  work = work.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    return `<a href="${escapeHtmlForTelegram(url)}">${text}</a>`;
  });

  // Step 5: bold before italic so ** does not match as two italics.
  work = work.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  work = work.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // Italic: *x* or _x_ with word-boundary guards so variable_names
  // and intra-word asterisks are not mangled.
  work = work.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  work = work.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<i>$2</i>');

  // Step 6: restore fenced blocks.
  work = work.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => {
    const { lang, code } = fenced[Number(i)];
    const escaped = escapeHtmlForTelegram(code);
    if (lang) {
      return `<pre><code class="language-${escapeHtmlForTelegram(lang)}">${escaped}</code></pre>`;
    }
    return `<pre>${escaped}</pre>`;
  });

  // Step 7: restore inline code.
  work = work.replace(/\u0000INLINE(\d+)\u0000/g, (_, i) => {
    return `<code>${escapeHtmlForTelegram(inline[Number(i)])}</code>`;
  });

  return work;
}

/**
 * Split markdown into <=max-char chunks, preferring paragraph then
 * line breaks so we do not shear through inline spans. Does not try
 * to split inside fenced code blocks; those are left whole even if
 * they push the chunk over max.
 */
function splitMarkdownForTelegram(md, max = 4000) {
  if (md.length <= max) return [md];
  const chunks = [];
  let remaining = md;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n\n', max);
    if (cut < max / 3) cut = remaining.lastIndexOf('\n', max);
    if (cut < max / 3) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env. Aborting.');
    process.exit(1);
  }

  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const claudeArgs = [];
  if (args.resumeSessionId) {
    claudeArgs.push('--resume', args.resumeSessionId);
  }
  claudeArgs.push(...args.claudeArgs);

  console.log(`cc-telegram starting`);
  console.log(`  Claude command:  ${claudeCmd} ${claudeArgs.join(' ') || '(interactive, new session)'}`);
  console.log(`  Working dir:     ${CWD}`);
  console.log(`  Telegram chat:   ${chatId}`);
  console.log(`  Mirror responses:${args.mirror ? ' ON' : ' OFF'}`);
  console.log(`  Stop:            Ctrl-C (both claude and the poller unwind)`);
  console.log('');

  // Shared references used by both the mirror and the injector:
  //   sessionFileRef.path  -> absolute path of the session jsonl once
  //                           known. Used by the injector to verify
  //                           submissions via ground-truth user records.
  //   ptyOutput            -> rolling buffer of recent PTY bytes (cap
  //                           PTY_BUFFER_CAP). The injector checks this
  //                           to distinguish "drafted but not submitted"
  //                           from "lost before reaching TUI".
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const sanitizedCwd = CWD.replace(/[:\\/]/g, '-');
  const projectDir = join(projectsRoot, sanitizedCwd);
  const sessionFileRef = {
    path: args.resumeSessionId
      ? join(projectDir, `${args.resumeSessionId}.jsonl`)
      : null,
  };
  const PTY_BUFFER_CAP = 50_000;
  let ptyOutput = '';

  // Start Claude Code inside a PTY so its TUI renders correctly.
  // Child cwd = CWD (the user's working dir) so `claude` resolves
  // the same session dir it would if launched directly.
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const child = ptySpawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: CWD,
    env: process.env,
  });

  // Quiescence tracker: every byte the child emits pushes `lastOutput`
  // forward. waitQuiet(ms, cap) returns once the PTY has been silent
  // for that long (or the cap elapses). We use this to time TG-driven
  // injections; see the injector onMessage below for rationale.
  let lastOutput = Date.now();
  const qWait = async (quietMs, capMs = 30_000) => {
    const start = Date.now();
    while (true) {
      const quietFor = Date.now() - lastOutput;
      if (quietFor >= quietMs) return true;
      if (Date.now() - start > capMs) return false;
      await new Promise((r) => setTimeout(r, Math.max(50, quietMs - quietFor)));
    }
  };

  // Pipe PTY output to real stdout so the user sees everything.
  child.onData((data) => {
    lastOutput = Date.now();
    ptyOutput = (ptyOutput + data).slice(-PTY_BUFFER_CAP);
    process.stdout.write(data);
  });
  child.onExit(({ exitCode }) => {
    injector.stop();
    process.exit(exitCode ?? 0);
  });

  // Pipe real stdin (user's keystrokes) into PTY. Raw mode so arrow
  // keys / ctrl sequences pass through.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (data) => {
    child.write(data.toString());
  });

  // Resize the PTY when the real terminal resizes.
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    try { child.resize(cols, rows); } catch { /* ignore */ }
  });

  // Mirror: tail the session's jsonl file instead of scraping PTY
  // output. The jsonl is the authoritative record of Claude's turns,
  // written atomically at turn boundaries. This gives us exact
  // assistant text (no spinner glyphs, no TUI redraw artifacts, no
  // timing heuristics).
  //
  // We poll the file every 1s, reading any new bytes appended since
  // last check, parsing JSONL records, and forwarding `assistant`
  // entries' text blocks to Telegram. Skip `thinking`, `tool_use`,
  // and `tool_result` blocks; those are operational noise.
  //
  // The session file path is determined from the resumed session id
  // (when --resume-session is passed) or detected by watching for
  // the newest jsonl in the current project's projects dir.
  const mirrorMinChars = 40;
  let mirrorController = null;
  if (args.mirror) {
    mirrorController = startJsonlMirror({
      repoRoot: CWD,
      resumeSessionId: args.resumeSessionId,
      onText: async (text) => {
        if (text.length < mirrorMinChars) return;
        await sendMirrorText(injector, text, { verbose: args.verbose });
      },
      onResolve: (p) => {
        sessionFileRef.path = p;
        if (args.verbose) console.error(`[tg] session file: ${p}`);
      },
      verbose: args.verbose,
    });
  }

  // If mirror is disabled but we still want verification (the common
  // case), start a lightweight path-detection loop on our own. This
  // duplicates a small amount of logic with startJsonlMirror but
  // avoids gating verification on the mirror being enabled.
  if (!args.mirror && !sessionFileRef.path) {
    void (async () => {
      const beforeSet = new Set();
      try {
        const entries = readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'));
        for (const e of entries) beforeSet.add(e);
      } catch { /* project dir may not exist yet */ }
      const deadline = Date.now() + 60_000;
      while (!sessionFileRef.path && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const entries = await readdir(projectDir);
          for (const f of entries) {
            if (!f.endsWith('.jsonl')) continue;
            if (beforeSet.has(f)) continue;
            sessionFileRef.path = join(projectDir, f);
            if (args.verbose) console.error(`[tg] detected session file: ${sessionFileRef.path}`);
            break;
          }
        } catch { /* retry */ }
      }
    })();
  }

  // The injector: on each Telegram message, write it to the PTY.
  //
  // Injection is a three-layer machine:
  //
  //   LAYER 1  byte sequence    body + '\r' in one write (proven by
  //                             scripts/probe.mjs: 8/8
  //                             when TUI is ready, AQ2).
  //
  //   LAYER 2  timing           quiesce the PTY for INJECT_QUIET_MS
  //                             before writing. Claude Code emits
  //                             ESC[?2004h during setRawMode, before
  //                             React has mounted the Ink TextInput;
  //                             the only reliable "mount complete"
  //                             signal is PTY silence. ~2s empirically.
  //
  //   LAYER 3  verify + retry   after every write, watch the session
  //                             jsonl for a `user` record containing
  //                             the message body. If not seen within
  //                             VERIFY_MS, fall through a ladder of
  //                             fallbacks rather than silent-drop:
  //
  //      (a) primary:  quiesce + body + CR
  //      (b) if body IS in recent PTY   = drafted: bare CR (submit)
  //      (c) if body NOT in recent PTY  = lost: quiesce + body + CR
  //      (d) if still nothing: wake CR + quiesce + body + CR
  //      (e) if still nothing: notify operator via TG; do not silent-drop
  //
  // Empty submits (bare CR with empty input box) are no-ops in Claude
  // Code's TUI, so fallback (b) is safe even if the primary actually
  // did submit and the input box is already empty.
  //
  // While Claude is streaming a response, PTY quiescence never
  // resolves, so the whole ladder simply waits out the current turn;
  // messages queue behind in-flight work rather than interleaving.
  //
  // Rerun scripts/probe.mjs if the CLI's TUI behavior
  // changes and AQ2 stops being the right primary strategy.
  const INJECT_QUIET_MS = 2000;
  const INJECT_QUIET_CAP_MS = 30_000;
  const VERIFY_PRIMARY_MS = 7_000;
  const VERIFY_RETRY_MS = 5_000;

  // Counts user-type records whose content contains `bodyFragment`.
  // We need this as a before/after snapshot so a repeat message
  // (same body text as a prior turn) does not cause verify to
  // spuriously pass by matching the *old* user record.
  const countMatchingUserEntries = async (bodyFragment) => {
    const filePath = sessionFileRef.path;
    if (!filePath) return 0;
    let count = 0;
    try {
      const content = await readFile(filePath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj?.type !== 'user') continue;
        const c = obj?.message?.content;
        if (typeof c === 'string' && c.includes(bodyFragment)) { count++; continue; }
        if (Array.isArray(c)) {
          for (const b of c) {
            if (typeof b?.text === 'string' && b.text.includes(bodyFragment)) {
              count++;
              break;
            }
          }
        }
      }
    } catch { /* file not yet there */ }
    return count;
  };

  // Returns true as soon as the count of matching user records
  // exceeds `baseline`. Parses only the tail (last ~30 lines) each
  // poll for efficiency. Pre-filtering raw line bytes is deliberately
  // skipped because escaped characters (\", \n) in stored JSON would
  // cause false negatives against the raw body text from Telegram.
  const verifyCountIncrement = async (bodyFragment, baseline, timeoutMs) => {
    const filePath = sessionFileRef.path;
    if (!filePath) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await countMatchingUserEntries(bodyFragment);
      if (current > baseline) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };

  const injectAndVerify = async (body) => {
    // Snapshot count of matching user entries BEFORE we send so a
    // repeat message (same text as an earlier turn) does not
    // spuriously verify by matching the prior record.
    const baseline = await countMatchingUserEntries(body);
    const attempts = [];
    const logAttempt = (label, ok, extra) => {
      attempts.push({ label, ok, ...extra });
      if (args.verbose) {
        console.error(`[tg] inject attempt [${label}] -> ${ok ? 'submitted' : 'not verified'}${extra ? ' ' + JSON.stringify(extra) : ''}`);
      }
    };
    const verify = (ms) => verifyCountIncrement(body, baseline, ms);

    // (a) primary: quiesce then body + CR.
    await qWait(INJECT_QUIET_MS, INJECT_QUIET_CAP_MS);
    child.write(body + '\r');
    if (await verify(VERIFY_PRIMARY_MS)) {
      logAttempt('primary', true);
      return { ok: true, via: 'primary', attempts };
    }
    logAttempt('primary', false);

    // (b) draft present in PTY -> submit it with bare CR. Safe if
    // input is actually empty: Claude Code no-ops on empty Enter.
    const bodyEcho = body.slice(0, Math.min(40, body.length));
    const drafted = ptyOutput.includes(bodyEcho);
    if (drafted) {
      child.write('\r');
      if (await verify(VERIFY_RETRY_MS)) {
        logAttempt('submit-draft', true);
        return { ok: true, via: 'submit-draft', attempts };
      }
      logAttempt('submit-draft', false);
    }

    // (c) re-inject after another quiescence cycle.
    await qWait(1500, 10_000);
    child.write(body + '\r');
    if (await verify(VERIFY_RETRY_MS)) {
      logAttempt('requiesce', true);
      return { ok: true, via: 'requiesce', attempts };
    }
    logAttempt('requiesce', false);

    // (d) wake-up CR first (exits any lingering modal or paste
    // state the TUI might be in), then full quiesce + body.
    child.write('\r');
    await qWait(1500, 10_000);
    child.write(body + '\r');
    if (await verify(VERIFY_RETRY_MS)) {
      logAttempt('wake-up', true);
      return { ok: true, via: 'wake-up', attempts };
    }
    logAttempt('wake-up', false);

    return { ok: false, via: null, attempts };
  };

  const injector = new TelegramInjector({
    botToken,
    chatId,
    verbose: args.verbose,
    onMessage: async ({ text }) => {
      const body = text.replace(/[\r\n]+$/g, '');
      const result = await injectAndVerify(body);
      if (!result.ok) {
        const preview = body.length > 100 ? body.slice(0, 100) + '...' : body;
        console.error(`[tg] FAILED to submit after ${result.attempts.length} attempts: "${preview}"`);
        try {
          await injector.sendMessage(
            'WARNING: your message could not be submitted to Claude after 4 attempts ' +
            '(primary + 3 fallbacks). The TUI may be stuck. Message preview:\n\n' +
            preview,
          );
        } catch { /* ignore secondary failure */ }
      } else if (args.verbose) {
        console.error(`[tg] submitted via ${result.via} (${body.length} chars, ${result.attempts.length} attempts)`);
      }
    },
    onError: (err, ctx) => {
      if (args.verbose) console.error(`[tg] ${ctx}:`, err.message);
    },
  });
  injector.start();

  const shutdown = () => {
    injector.stop();
    if (mirrorController) mirrorController.stop();
    try { child.kill(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive via the child + stdin streams.
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function chunkForTelegram(text, max = 4000) {
  if (text.length <= max) return text;
  return text.slice(0, max - 40) + '\n\n...[truncated in mirror]';
}

/**
 * Start tailing the session's jsonl file for assistant turn outputs.
 * Returns a { stop } controller.
 *
 * Polls every 1s. Reads only bytes appended since last check so the
 * poll cost is bounded even for long sessions. Parses each appended
 * line as JSON, forwards `assistant` messages' text blocks to the
 * supplied onText callback.
 *
 * Path resolution:
 *   - If resumeSessionId given: watch
 *     ~/.claude/projects/<sanitized-cwd>/<resumeSessionId>.jsonl
 *     as soon as it exists.
 *   - Else: detect the session file by finding the newest-mtime jsonl
 *     in the project dir that wasn't there at wrapper start. Up to a
 *     30s wait; gives up quietly if none appears.
 */
function startJsonlMirror({ repoRoot, resumeSessionId, onText, onResolve, verbose }) {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const sanitized = repoRoot.replace(/[:\\/]/g, '-');
  const projectDir = join(projectsRoot, sanitized);

  const state = {
    filePath: null,
    offset: 0,
    partial: '', // last incomplete line, if any
    seenUuids: new Set(),
    timer: null,
    wallStart: Date.now(),
    initialSnapshot: new Set(),
    running: true,
    // Seek-to-end flag: on the first attach to a jsonl file, we set
    // offset = current size so historical assistant turns (from a
    // prior resumed session) are NOT mirrored. Only turns written
    // *after* wrapper start are forwarded.
    attached: false,
  };

  const resolveFilePath = (p) => {
    state.filePath = p;
    if (typeof onResolve === 'function') {
      try { onResolve(p); } catch { /* ignore callback errors */ }
    }
  };

  // If resume id given, we know the target file directly.
  if (resumeSessionId) {
    resolveFilePath(join(projectDir, `${resumeSessionId}.jsonl`));
  } else {
    // Snapshot current jsonls so a new one (the session we're about
    // to launch) can be distinguished when it appears.
    try {
      const entries = readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'));
      for (const e of entries) state.initialSnapshot.add(e);
    } catch {
      // project dir may not exist yet; fine
    }
  }

  const tick = async () => {
    if (!state.running) return;
    try {
      if (!state.filePath || !existsSync(state.filePath)) {
        // Detect mode: find a new jsonl that appeared since start.
        if (!resumeSessionId) {
          try {
            const entries = await readdir(projectDir);
            const jsonls = entries.filter((n) => n.endsWith('.jsonl'));
            const fresh = jsonls.filter((n) => !state.initialSnapshot.has(n));
            if (fresh.length > 0) {
              // Pick the most-recently-modified fresh file.
              let best = null;
              for (const n of fresh) {
                const s = await stat(join(projectDir, n));
                if (!best || s.mtimeMs > best.mtime) {
                  best = { path: join(projectDir, n), mtime: s.mtimeMs };
                }
              }
              resolveFilePath(best.path);
              if (verbose) console.error(`[mirror] tailing ${state.filePath}`);
            } else if (Date.now() - state.wallStart > 30_000) {
              // Give up detecting after 30s.
              state.running = false;
              return;
            }
          } catch {
            // project dir not yet present
          }
        }
        if (state.running && state.filePath === null) {
          state.timer = setTimeout(tick, 1_000);
          return;
        }
        if (!existsSync(state.filePath)) {
          state.timer = setTimeout(tick, 1_000);
          return;
        }
        if (verbose) console.error(`[mirror] tailing ${state.filePath}`);
      }

      // On first attach, seek to EOF and also register every existing
      // assistant uuid as "seen" so nothing historical is ever mirrored,
      // even if the writer rewrites or appends out-of-order.
      if (!state.attached) {
        const s0 = await stat(state.filePath);
        try {
          const existing = await readFile(state.filePath, 'utf8');
          for (const line of existing.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'assistant' && typeof obj.uuid === 'string') {
                state.seenUuids.add(obj.uuid);
              }
            } catch { /* skip malformed */ }
          }
        } catch { /* fine, we will still skip via offset */ }
        state.offset = s0.size;
        state.attached = true;
        if (verbose) console.error(`[mirror] attached at EOF (${s0.size} bytes, ${state.seenUuids.size} historical assistant turns skipped)`);
      }

      // Read appended bytes since last offset.
      const s = await stat(state.filePath);
      if (s.size > state.offset) {
        const fh = await openFile(state.filePath, 'r');
        try {
          const length = s.size - state.offset;
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, state.offset);
          state.offset = s.size;
          const chunk = state.partial + buf.toString('utf8');
          const lines = chunk.split(/\r?\n/);
          state.partial = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.type !== 'assistant') continue;
            const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
            if (uuid && state.seenUuids.has(uuid)) continue;
            if (uuid) state.seenUuids.add(uuid);
            const text = extractAssistantText(obj.message);
            if (text && text.trim().length > 0) {
              try { await onText(text); } catch (e) { if (verbose) console.error('[mirror] onText threw:', e.message); }
            }
          }
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      if (verbose) console.error('[mirror] tick error:', err.message);
    } finally {
      if (state.running) state.timer = setTimeout(tick, 1_000);
    }
  };

  state.timer = setTimeout(tick, 500);

  return {
    stop() {
      state.running = false;
      if (state.timer) clearTimeout(state.timer);
    },
  };
}

/**
 * Extract the text content from an assistant message body. Skips
 * `thinking`, `tool_use`, `tool_result`. Concatenates multiple text
 * blocks with blank lines between.
 */
function extractAssistantText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join('\n\n').trim();
}

main().catch((err) => {
  console.error('cc-telegram failed:', err);
  process.exit(1);
});
