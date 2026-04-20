/**
 * CLI-style Telegram renderer.
 *
 * Turns a stream of CliRendererEvents into a coherent, rate-limited,
 * CLI-style message flow on Telegram (or any post/edit-capable channel).
 * Ported from the LAG project; vendor-neutral by design.
 *
 * Public surface:
 *   CliRenderer            - event consumer that drives a Channel
 *   createTelegramChannel  - CliRendererChannel bound to Telegram Bot API
 *   startJsonlMirror       - tails a Claude Code session jsonl and emits
 *                            CliRendererEvents; drives the renderer end-to-end
 *   summarizeToolUse       - helper that produces a compact tool-call label
 */
export { CliRenderer } from './renderer.js';
export { createTelegramChannel } from './telegram-channel.js';
export { emptyAccumulator, parseClaudeStreamLine, summarizeToolUse, } from './claude-stream-parser.js';
export { startJsonlMirror } from './jsonl-mirror.js';
