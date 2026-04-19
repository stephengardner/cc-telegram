#!/usr/bin/env node
/**
 * Holistic matrix probe for Claude Code TUI submission behavior.
 *
 * Reproduces the observed user bug: "first injected message drafts,
 * second one submits." Runs a matrix of (strategy x condition) cells
 * so a winning strategy must pass *every* cell to be shipped.
 *
 * Dimensions:
 *   STRATEGIES:  different ways of delivering text + submit signal
 *                to the PTY stdin (see STRATEGIES below).
 *   CONDITIONS:  spawn mode (fresh vs --resume) x pre-injection wait
 *                (3s vs 8s, to cover both "TUI still loading" and
 *                "TUI fully settled" states).
 *   CYCLES:      single (send one marker) and double (send two
 *                markers 500ms apart, require BOTH to land as
 *                separate user records; catches the
 *                "first-drafts-second-sends" failure mode).
 *
 * Ground-truth test: the session jsonl record at
 * ~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl is the
 * authoritative log of submitted turns. A test passes if every
 * unique marker string appears in a `user` entry's content within
 * the wait deadline.
 *
 * Usage:
 *   node scripts/probe.mjs
 *   node scripts/probe.mjs --resume-session <id>
 *   node scripts/probe.mjs --only A,A2,PC
 *   node scripts/probe.mjs --conditions fresh-3s,resume-8s
 *   node scripts/probe.mjs --wait-ms 30000
 *
 * Output:
 *   - Per-cell PASS/FAIL line with TTFS (time-to-first-submission)
 *   - Matrix table (strategies as rows, conditions as cols)
 *   - Universal winners: strategies that pass every condition
 *   - PTY output logs saved under probe-logs/ for forensics
 */

import { spawn as ptySpawn } from 'node-pty';
import { readFile, readdir } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Probe runs against the user's current working directory so it
// exercises the same Claude session dir the real launcher will use.
const CWD = process.cwd();
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');
const LOG_DIR = join(CWD, 'probe-logs');

function sanitize(cwd) { return cwd.replace(/[:\\/]/g, '-'); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Strategies. Each delivers `text` and a submit signal to the PTY via `w`.
// A "cycle" passes if the jsonl gains a user record containing the marker.
// ---------------------------------------------------------------------------
const STRATEGIES = [
  {
    id: 'A',
    desc: 'text + CR',
    run: async (w, text) => { w(text + '\r'); },
  },
  {
    id: 'A2',
    desc: 'text + CR, 300ms, CR',
    run: async (w, text, s) => { w(text + '\r'); await s(300); w('\r'); },
  },
  {
    id: 'A3',
    desc: 'text + CR, 100ms, CR, 100ms, CR',
    run: async (w, text, s) => {
      w(text + '\r'); await s(100); w('\r'); await s(100); w('\r');
    },
  },
  {
    id: 'PC',
    desc: 'CR, 200ms, text + CR',
    run: async (w, text, s) => { w('\r'); await s(200); w(text + '\r'); },
  },
  {
    id: 'PS',
    desc: 'space+bksp, 200ms, text + CR',
    run: async (w, text, s) => { w(' \b'); await s(200); w(text + '\r'); },
  },
  {
    id: 'PSQ',
    desc: 'space+bksp, quiesce 500ms, text + CR',
    run: async (w, text, s, ctx) => {
      w(' \b');
      await ctx.waitQuiet(500);
      w(text + '\r');
    },
  },
  {
    id: 'Q',
    desc: 'quiesce 500ms, text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitQuiet(500);
      w(text + '\r');
    },
  },
  {
    // The authoritative strategy per Claude Code source analysis:
    //   1. force-exit any active bracketed-paste state (so the body
    //      cannot land inside a paste region, which would route to
    //      onPaste and never submit);
    //   2. write body (no trailing CR);
    //   3. 50ms flush so the tokenizer completes the body feed;
    //   4. bare CR as its own write -> tokenized as
    //      {name:"return", isPasted:false} outside paste = submit.
    id: 'X',
    desc: 'ESC[201~ + body, 50ms, bare CR',
    run: async (w, text, s) => {
      w('\x1b[201~');
      w(text);
      await s(50);
      w('\r');
    },
  },
  {
    // Same as X but waits for the TUI ready signal (ESC[?2004h on
    // stdout) before firing. Matrix evidence shows this alone is
    // insufficient because 2004h is emitted synchronously during
    // setRawMode, BEFORE React has mounted the TextInput component.
    // Kept as a data point; the real winner is FINAL below.
    id: 'XR',
    desc: 'wait ESC[?2004h + ESC[201~ + body, 50ms, bare CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitReady(15000);
      w('\x1b[201~');
      w(text);
      await s(50);
      w('\r');
    },
  },
  {
    // AR: A with ready-signal gate only. Tests: is ESC[?2004h alone
    // a sufficient readiness marker?
    id: 'AR',
    desc: 'wait ESC[?2004h + text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitReady(15_000);
      w(text + '\r');
    },
  },
  {
    // AQ1: A with quiescence gate only (1200ms). Tests: is
    // quiescence alone a sufficient readiness marker?
    id: 'AQ1',
    desc: 'quiesce 1200ms + text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitQuiet(1200, 15_000);
      w(text + '\r');
    },
  },
  {
    // AQ2: A with 2000ms quiescence. Tests: is longer quiescence
    // required to catch full React mount?
    id: 'AQ2',
    desc: 'quiesce 2000ms + text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitQuiet(2000, 15_000);
      w(text + '\r');
    },
  },
  {
    // AQ3: A with 3000ms quiescence.
    id: 'AQ3',
    desc: 'quiesce 3000ms + text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitQuiet(3000, 15_000);
      w(text + '\r');
    },
  },
  {
    // ARQ2: combined gate - ready signal then 2000ms quiescence.
    id: 'ARQ2',
    desc: 'wait 2004h + quiesce 2000ms + text + CR',
    run: async (w, text, s, ctx) => {
      await ctx.waitReady(15_000);
      await ctx.waitQuiet(2000, 15_000);
      w(text + '\r');
    },
  },
];

// ---------------------------------------------------------------------------
// Conditions.
// ---------------------------------------------------------------------------
const CONDITIONS = [
  { id: 'fresh-3s',  spawn: 'fresh',  waitMs: 3000 },
  { id: 'fresh-8s',  spawn: 'fresh',  waitMs: 8000 },
  { id: 'resume-3s', spawn: 'resume', waitMs: 3000 },
  { id: 'resume-8s', spawn: 'resume', waitMs: 8000 },
];

// Resume conditions require a throwaway session id to resume. The
// user supplies one via --resume-session; otherwise resume cells are
// skipped. Never bake in a default, different users have different
// session ids.
const DEFAULT_RESUME_ID = null;

// ---------------------------------------------------------------------------
// Arg parsing.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    resumeId: DEFAULT_RESUME_ID,
    onlyStrategies: null,
    onlyConditions: null,
    waitMs: 20_000,
    cycles: 'both', // 'single' | 'double' | 'both'
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeId = argv[++i];
    } else if (a === '--only' && i + 1 < argv.length) {
      args.onlyStrategies = new Set(argv[++i].split(',').map((s) => s.trim()));
    } else if (a === '--conditions' && i + 1 < argv.length) {
      args.onlyConditions = new Set(argv[++i].split(',').map((s) => s.trim()));
    } else if (a === '--wait-ms' && i + 1 < argv.length) {
      args.waitMs = Number(argv[++i]);
    } else if (a === '--cycles' && i + 1 < argv.length) {
      args.cycles = argv[++i];
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/probe.mjs [options]
  --resume-session <id>         Session id to resume for resume conditions
                                (required if testing resume-* conditions)
  --only S1,S2                  Only test listed strategies (IDs)
  --conditions C1,C2            Only test listed conditions
  --wait-ms <n>                 Max time to wait for submission (default 20000)
  --cycles single|double|both   Cycle mode (default: both)
  --verbose                     Print extra diagnostics`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Helpers: quiescence detector + jsonl marker watcher.
// ---------------------------------------------------------------------------
// Readiness signal from Claude Code: when the CLI calls setRawMode(true)
// it synchronously writes ESC[?2004h (enable bracketed paste, DEC mode
// 2004) among other mode-setting bytes. Seeing that on the child's
// stdout proves the TextInput is wired and ready to receive keystrokes.
// Source: cli.js, `setRawMode` startup writing `p_4` = ESC[?2004h.
const READY_SIGNAL = '\x1b[?2004h';

function makeQuiescenceTracker() {
  let lastOutput = Date.now();
  let everSeenReady = false;
  let readyResolver = null;
  const readyPromise = new Promise((res) => { readyResolver = res; });
  return {
    markOutput(data) {
      lastOutput = Date.now();
      if (!everSeenReady && typeof data === 'string' && data.includes(READY_SIGNAL)) {
        everSeenReady = true;
        readyResolver();
      }
    },
    get seenReady() { return everSeenReady; },
    async waitReady(timeoutMs = 20000) {
      if (everSeenReady) return true;
      return await Promise.race([
        readyPromise.then(() => true),
        sleep(timeoutMs).then(() => false),
      ]);
    },
    async waitQuiet(ms, capMs = 20_000) {
      const start = Date.now();
      while (true) {
        const quietFor = Date.now() - lastOutput;
        if (quietFor >= ms) return true;
        if (Date.now() - start > capMs) return false;
        await sleep(Math.max(50, ms - quietFor));
      }
    },
  };
}

async function waitForUserMarker(projectDir, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      for (const f of await readdir(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = join(projectDir, f);
        let content;
        try { content = await readFile(fp, 'utf8'); } catch { continue; }
        if (!content.includes(marker)) continue;
        for (const line of content.split(/\r?\n/)) {
          if (!line.includes(marker)) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user') return { passed: true, file: f, at: Date.now() };
          } catch { /* non-json or non-user */ }
        }
      }
    } catch { /* retry */ }
    await sleep(300);
  }
  return { passed: false, file: null, at: null };
}

// ---------------------------------------------------------------------------
// Single-cell runner: one (strategy x condition x cycle-mode) test.
// ---------------------------------------------------------------------------
async function runCell({ strategy, condition, cycle, resumeId, waitMs }) {
  const projectDir = join(PROJECTS_ROOT, sanitize(CWD));
  const sessionId = condition.spawn === 'resume' ? resumeId : null;
  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const claudeArgs = sessionId ? ['--resume', sessionId] : [];

  const spawnStart = Date.now();
  const child = ptySpawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: CWD,
    env: process.env,
  });

  const q = makeQuiescenceTracker();
  let outputCapture = '';
  child.onData((d) => {
    q.markOutput(d);
    outputCapture += d;
  });

  await sleep(condition.waitMs);

  // Build markers and fire the cycle.
  const results = [];
  const markers = [];
  const runStrategy = (marker) => {
    const text = `probe ${marker}`;
    return strategy.run(
      (s) => child.write(s),
      text,
      sleep,
      q,
    );
  };

  const baseTag = `M-${strategy.id}-${condition.id}-${cycle}-${Date.now()}`;

  if (cycle === 'single') {
    const m = `${baseTag}-1`;
    markers.push(m);
    await runStrategy(m);
  } else if (cycle === 'double') {
    const m1 = `${baseTag}-1`;
    const m2 = `${baseTag}-2`;
    markers.push(m1, m2);
    await runStrategy(m1);
    await sleep(600);
    await runStrategy(m2);
  } else {
    throw new Error(`Unknown cycle: ${cycle}`);
  }

  // Wait for each marker to appear in a user entry.
  for (const marker of markers) {
    const w = await waitForUserMarker(projectDir, marker, waitMs);
    results.push({ marker, ...w });
  }

  try { child.kill(); } catch { /* ignore */ }
  await sleep(500);

  // Save forensic log.
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${strategy.id}_${condition.id}_${cycle}_${Date.now()}.log`);
  writeFileSync(logPath, JSON.stringify({
    strategy: { id: strategy.id, desc: strategy.desc },
    condition,
    cycle,
    markers,
    results,
    spawnStart,
    finishedAt: Date.now(),
    outputBytes: outputCapture.length,
    outputTail: outputCapture.slice(-2000),
  }, null, 2), 'utf8');

  const allPassed = results.every((r) => r.passed);
  return {
    strategyId: strategy.id,
    strategyDesc: strategy.desc,
    conditionId: condition.id,
    cycle,
    passed: allPassed,
    perMarker: results,
    logPath,
  };
}

// ---------------------------------------------------------------------------
// Matrix runner.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const strategies = args.onlyStrategies
    ? STRATEGIES.filter((s) => args.onlyStrategies.has(s.id))
    : STRATEGIES;
  let conditions = args.onlyConditions
    ? CONDITIONS.filter((c) => args.onlyConditions.has(c.id))
    : CONDITIONS;
  const cycles = args.cycles === 'both'
    ? ['single', 'double']
    : [args.cycles];

  // Skip resume-* conditions if no session id was supplied; otherwise
  // they would silently fall back to a fresh spawn and muddle results.
  if (!args.resumeId) {
    const before = conditions.length;
    conditions = conditions.filter((c) => c.spawn !== 'resume');
    const skipped = before - conditions.length;
    if (skipped > 0) {
      console.log(`Skipped ${skipped} resume-* condition(s): pass --resume-session <id> to include them.`);
    }
  }

  if (strategies.length === 0 || conditions.length === 0) {
    console.error('No strategies or conditions selected after filtering.');
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const totalCells = strategies.length * conditions.length * cycles.length;
  console.log(`Matrix probe: ${strategies.length} strategies x ${conditions.length} conditions x ${cycles.length} cycles = ${totalCells} cells`);
  console.log(`Resume session: ${args.resumeId}`);
  console.log(`Logs:           ${LOG_DIR}`);
  console.log('');

  const cells = [];
  let i = 0;
  for (const strategy of strategies) {
    for (const condition of conditions) {
      for (const cycle of cycles) {
        i++;
        const tag = `[${String(i).padStart(2, '0')}/${String(totalCells).padStart(2, '0')}]`;
        const label = `${strategy.id.padEnd(4)} ${condition.id.padEnd(11)} ${cycle.padEnd(7)}`;
        process.stdout.write(`  ${tag} ${label} : ${strategy.desc.padEnd(40)} `);
        const r = await runCell({
          strategy,
          condition,
          cycle,
          resumeId: args.resumeId,
          waitMs: args.waitMs,
        });
        cells.push(r);
        const hits = r.perMarker.filter((m) => m.passed).length;
        const badge = r.passed ? 'PASS' : 'FAIL';
        console.log(`${badge}  (${hits}/${r.perMarker.length} submitted)`);
      }
    }
  }

  // Print matrix (one matrix per cycle mode).
  for (const cycle of cycles) {
    console.log(`\nMatrix [cycle=${cycle}]:`);
    const pad = (s, n) => String(s).padEnd(n);
    const head = `  ${pad('strategy', 40)} ${conditions.map((c) => pad(c.id, 12)).join(' ')}`;
    console.log(head);
    for (const s of strategies) {
      const cols = conditions.map((c) => {
        const cell = cells.find((x) => x.strategyId === s.id && x.conditionId === c.id && x.cycle === cycle);
        return pad(cell ? (cell.passed ? 'PASS' : 'FAIL') : '-', 12);
      });
      console.log(`  ${pad(s.id + ' ' + s.desc, 40)} ${cols.join(' ')}`);
    }
  }

  // Universal winners: pass every cell.
  console.log('\n');
  const universal = strategies.filter((s) => {
    return cells
      .filter((c) => c.strategyId === s.id)
      .every((c) => c.passed);
  });
  if (universal.length === 0) {
    console.log('NO universal-winning strategy. Review matrix + logs to diagnose.');
  } else {
    console.log('Universal winners (pass every cell):');
    for (const u of universal) {
      console.log(`  ${u.id}: ${u.desc}`);
    }
  }
}

main().catch((err) => {
  console.error('matrix probe failed:', err);
  process.exit(1);
});
