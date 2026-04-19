# cc-telegram

Bidirectional bridge between a live Claude Code TUI session and Telegram. Messages you send to the bot are injected into the agent's stdin as if you had typed them in the terminal, and Claude's turn responses are mirrored back to your Telegram chat. Same session, same jsonl, same flow whether you are at the computer or on your phone.

Not affiliated with Anthropic. This is a personal tool that talks to the Claude Code CLI over a PTY.

## Why

You leave a Claude Code session running on your desktop. You step away. Now you want to nudge the agent, approve a plan, or watch a long-running task from your phone without remoting into the machine. cc-telegram makes that a five-minute setup.

## Prereqs

- Node 22 or later
- `claude` CLI installed and authenticated (`claude /login`)
- A Telegram bot (create one via [@BotFather](https://t.me/BotFather))

## Install

Clone and install locally:

```bash
git clone https://github.com/stephengardner/cc-telegram.git
cd cc-telegram
npm install
```

Or install globally so the `cc-telegram` command is on your PATH anywhere:

```bash
npm install -g cc-telegram
```

## Configure

Create `.env` in whatever directory you launch from (or copy `.env.example`):

```
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token-from-botfather
TELEGRAM_CHAT_ID=123456789
```

Getting the chat id: after your bot is created, send it any message in Telegram, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the `message.chat.id` value from the JSON response.

## Run

Fresh Claude Code session:

```bash
cc-telegram
```

Resume a specific session (grab the id from `~/.claude/projects/<sanitized-cwd>/<id>.jsonl`):

```bash
cc-telegram --resume-session <session-id>
```

Forward extra arguments to `claude`:

```bash
cc-telegram --claude-args "--permission-mode auto"
```

Turn off the response mirror (messages in, no messages back):

```bash
cc-telegram --no-mirror
```

Stop: Ctrl-C in the wrapper terminal. The child `claude` exits cleanly and the poller stops.

## How it works

```
 ┌─────────────┐   stdin injection    ┌──────────────────┐
 │  Telegram   │ ───────────────────▶ │ Claude Code TUI  │
 │    user     │                      │  (PTY child)     │
 │             │ ◀─────────────────── │                  │
 └─────────────┘   jsonl mirror       └──────────────────┘
       ▲                                       │
       │                                       ▼
       │                                 session jsonl
       │                                  (authoritative
       │                                   record of turns)
       │                                       │
       └───────────────────────────────────────┘
                 wrapper tails file,
                 mirrors new `assistant`
                 entries as formatted HTML
```

1. `cc-telegram` spawns `claude` as a [node-pty](https://github.com/microsoft/node-pty) child, wiring stdin/stdout to your terminal so the TUI renders normally.
2. A long-poller hits the Telegram Bot API every ~2 seconds for new messages in your chat.
3. Each incoming Telegram message is written to the child's stdin, followed by a carriage return to submit.
4. In parallel, the wrapper tails the session's jsonl file (`~/.claude/projects/<sanitized-cwd>/<session>.jsonl`). Every new `assistant` entry is converted from markdown to Telegram HTML and sent back to the chat.

## Injection reliability

Claude Code's TUI is built on [Ink](https://github.com/vadimdemedes/ink) (React for CLIs). Naively writing `body + '\r'` to the PTY works **only** if the TextInput component is mounted and the paste-state tokenizer is not in a bracketed paste region. In practice that means:

- **Quiescence gate.** The wrapper waits for 2 seconds of PTY output silence before each injection. This is the reliable "component mounted" signal because `ESC[?2004h` (the only explicit ready byte) fires synchronously during `setRawMode`, well before React mounts the input.
- **Verify, don't trust.** After sending, the wrapper tails the session jsonl for a new `user` record containing the body. If it does not appear within 7 seconds, it escalates through a fallback ladder.
- **Fallback ladder.** (a) If the body IS in recent PTY output, send a bare `\r` to submit the draft. (b) Re-quiesce and re-send. (c) Wake up with a bare `\r`, re-quiesce, re-send. (d) If all four attempts fail, push a warning message back to the Telegram chat instead of silently dropping.

You get a happy-path submission in ~3-5 seconds and a ~25-second worst-case ceiling before you are notified of a stuck TUI.

## Reproducing the reliability tests

The wrapper's byte sequence is not theoretical. `scripts/probe.mjs` drives Claude Code through a 48-cell matrix (6 strategies x 4 spawn/wait conditions x single/double send cycles) and confirms submission by watching the session jsonl for user records.

```bash
npm run probe

# Only test specific strategies:
node scripts/probe.mjs --only A,AQ2

# Include resume-* conditions (requires a throwaway session id):
node scripts/probe.mjs --resume-session <session-id>
```

Forensic PTY output logs land under `probe-logs/`.

## Troubleshooting

**"TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env"**: either put them in a `.env` in the directory you run `cc-telegram` from, or export them into your shell before running.

**Bot sees no messages**: make sure your bot token is correct, and that you have sent the bot at least one message so Telegram has a chat to read from.

**Message appears as draft but does not submit**: this is exactly what the verify+retry ladder is for. If it is still happening, run with `--verbose` and file an issue. Include the captured `[tg] inject attempt` lines.

**Mirror is noisy**: the mirror only forwards `assistant` messages with at least 40 characters of text content, which skips tool-use and thinking blocks. If you want to gate further, edit `mirrorMinChars` in `bin/cc-telegram.mjs`.

## License

MIT. See LICENSE.
