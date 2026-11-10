#!/usr/bin/env node
/**
 * S0 / T06 acceptance engine (automated tier).
 *
 * Drives the full loop with REAL Claude Code permission prompts inside REAL
 * VS Code terminal panels:
 *
 *   host (state machine + simulated screen + big key)
 *     ▲ hook events (async)            ▲ focus-request / test-control
 *     │                                │
 *   claude -p sessions  ──►  VS Code extension (per window, AUTOTEST=1)
 *                            creates real terminals, shows them on request
 *
 * Per run:
 *   1. runner tells host → extension: create terminal, run claude -p with a
 *      one-tool prompt in the sandbox cwd. The permission prompt appears in
 *      the real terminal; our MCP permission server (the official
 *      permission host channel) receives it and holds the decision.
 *   2. hooks report waiting → screen card appears (snapshot).
 *   3. runner triggers the big key (same handler as the physical hotkey).
 *   4. host: focus-request → extension Terminal.show → receipt;
 *      SetForegroundWindow on the bound HWND → foreground verified.
 *   5. runner releases the permission decision (allow) → tool runs →
 *      Stop/SessionEnd → card clears → terminal disposed.
 *
 * Groups:
 *   same-window : 20 runs alternating two terminals in ONE window
 *   cross-window: 20 runs alternating one terminal in EACH of two windows
 * Scenario mix per group: duplicate terminal names (selection must not
 * depend on titles), minimized window restore, foreign foreground app,
 * session exit mid-loop.
 *
 * Usage: node tests/run-g0.mjs [--group both|same|cross] [--runs 20]
 *        [--forward ms-edge|browser] [--keep-windows]
 * Requires: host.mjs serve running; two VS Code windows opened with
 *   VIBE_AUTOTEST=1 code --extensionDevelopmentPath <ext> --folder-uri <sandbox>
 */
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, appendFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'src/vscode-extension');
const PIPE = process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}
function flag(name) { return args.includes(`--${name}`); }
const GROUP = opt('group', 'both'); // same | cross | both
const RUNS = Number(opt('runs', 20));
const KEEP = flag('keep-windows');
const NOLAUNCH = flag('no-launch'); // reuse already-open sandbox windows

// ------------------------------------------------------------------ hub conn

const sock = net.connect(PIPE);
let buf = '';
const handlers = new Map(); // t -> fn[]
const runResults = [];
sock.on('error', (e) => { console.error('hub connection failed:', e.message); process.exit(1); });
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!l) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    for (const fn of handlers.get(m.t) || []) fn(m);
    for (const fn of handlers.get('*') || []) fn(m);
  }
});
sock.on('connect', () => {
  sock.write(JSON.stringify({ t: 'hello', role: 'runner' }) + '\n');
});
function on(t, fn) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); }
function send(o) { sock.write(JSON.stringify(o) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(pred, timeoutMs, pollMs = 60) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = pred();
      if (v) { clearInterval(iv); resolve(v); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(null); }
    }, pollMs);
  });
}

// Track screen snapshots + extension registrations.
let latestSnapshot = null;
const windows = new Map(); // windowId -> {hwnd, terminals:Map}
const sandboxWindowIds = new Map(); // sandbox name -> windowId (from bind-force)
on('snapshot', (s) => { latestSnapshot = s; });
on('window-bound', (m) => {
  const w = windows.get(m.windowId) || { terminals: new Map() };
  w.hwnd = m.hwnd;
  windows.set(m.windowId, w);
});
on('terminal', (m) => {
  const w = windows.get(m.windowId) || { terminals: new Map() };
  if (m.action === 'add') w.terminals.set(m.binding, m.name);
  else w.terminals.delete(m.binding);
  windows.set(m.windowId, w);
});
on('run-result', (r) => { runResults.push(r); });

// ---------------------------------------------------------------- helpers

async function launchWindows() {
  const cmd = (sandbox, isolated) => [
    '--extensionDevelopmentPath', EXT,
    ...(isolated ? ['--user-data-dir', path.join(os.tmpdir(), 'vscode-g0-b')] : []),
    '--new-window',
    path.join(ROOT, 'tests/fixtures', sandbox),
    '--disable-workspace-trust',
  ];
  // Windows already up are reused. New windows launch SERIALLY through the
  // HOST: runner-side spawns land in the runner's isolated desktop (exebox)
  // where the user cannot see them; the host spawns on the real desktop.
  // Serial also avoids the single-instance CLI new-window race; window B
  // uses an isolated user-data-dir (forwarded new-window requests from a
  // busy extension host get dropped, observed 3/3).
  const launchViaHost = (args) => new Promise((resolve) => {
    send({ t: 'test-control', action: 'launch-window', bin: 'code', args });
    setTimeout(resolve, 1500);
  });
  const ensure = async (sb, isolated) => {
    if (await waitFor(async () => Boolean(await hwndOfShared(sb)), 10000, 2000)) { console.log(`[run-g0] ${sb} window already up`); return true; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await launchViaHost(cmd(sb, isolated));
      if (await waitFor(async () => Boolean(await hwndOfShared(sb)), isolated ? 90000 : 60000, 3000)) return true;
      console.log(`[run-g0] ${sb} not up (attempt ${attempt}), respawning...`);
    }
    return false;
  };
  await ensure('sandbox-A', false);
  await ensure('sandbox-B', true);
}

// shared: enumerate windows through the host's real-desktop sidecar
async function hwndOfShared(sb) {
  const r = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    on('test-ack', (m) => { if (m.action === 'list-windows') { clearTimeout(timer); resolve(m); } });
    send({ t: 'test-control', action: 'list-windows' });
  });
  for (const line of r?.windows || []) {
    const m = line.match(/^(\d+) \| (.+)$/);
    if (m && m[2].includes(sb)) return Number(m[1]);
  }
  return 0;
}

function bindWindows() {
  console.log('[run-g0] 请在弹出的两个 VS Code 窗口中各执行一次命令: Vibe: 绑定本窗口 (bindWindow)');
  console.log('[run-g0] 等待两个窗口完成绑定 (window-bound)...');
}

// Automated binding: activate each sandbox-titled VS Code window via
// activate-window.ps1, then broadcast bind-now (hub forwards to every
// extension) — only the foreground window passes the focus checks inside
// bindWindowCommand. Falls back to the manual prompt above on failure.
async function autoBindWindows() {
  const ps1 = path.join(ROOT, 'scripts/ps/activate-window.ps1');
  const deadline = Date.now() + 180000;
  const boundSb = new Set();
  // window enumeration goes through the HOST (real desktop); this runner
  // process lives in an isolated desktop (exebox) and cannot see the user's
  // windows at all
  const hwndOf = async (sb) => {
    const r = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      on('test-ack', (m) => { if (m.action === 'list-windows') { clearTimeout(timer); resolve(m); } });
      send({ t: 'test-control', action: 'list-windows' });
    });
    for (const line of r?.windows || []) {
      const m = line.match(/^(\d+) \| (.+)$/);
      if (m && m[2].includes(sb)) return { hwnd: Number(m[1]), title: m[2] };
    }
    return null;
  };
  while (Date.now() < deadline && boundSb.size < 2) {
    for (const sb of ['sandbox-A', 'sandbox-B']) {
      if (boundSb.has(sb)) continue;
      const w = await hwndOf(sb);
      if (!w) { console.log(`[run-g0] window not visible yet: ${sb}`); continue; }
      // lock-screen-safe binding: the extension verifies the workspace name
      // and accepts the title-matched hwnd without a foreground check
      // (SetForegroundWindow is denied system-wide when no window can be
      // foreground; activation is validated separately by the big-key flow)
      send({ t: 'test-control', action: 'bind-force', workspace: sb, hwnd: w.hwnd });
      await sleep(1500);
      const nowBound = [...windows.values()].filter((x) => x.hwnd).length;
      if (nowBound > boundSb.size) {
        boundSb.add(sb);
        const wid = [...windows.entries()].find(([, x]) => x.hwnd === w.hwnd)?.[0];
        if (wid) sandboxWindowIds.set(sb, wid);
        console.log(`[run-g0] auto-bound ${sb} (hwnd ${w.hwnd}, window ${wid})`);
      } else console.log(`[run-g0] bind-force no effect for ${sb} (hwnd ${w.hwnd})`);
    }
    if (boundSb.size < 2) await sleep(2000);
  }
  return boundSb.size === 2;
}

async function startSessionIn(binding, sandbox, { duplicateName, extraArgs = '' } = {}) {
  const cwd = path.join(ROOT, 'tests/fixtures', sandbox);
  const settingsPath = writeTemp(`settings-${binding}`, makeSessionSettings(binding));
  const mcpPath = writeTemp(`mcp-${binding}`, makeMcpConfig(binding));
  // CJK prompt via stdin redirect — the extension executes this command line
  // through cmd /s /c, where every path must stay quote-free (all space-free)
  // and inline quoted text gets mangled by node/cmd escaping.
  const promptPath = settingsPath.replace(/\.json$/, '-prompt.txt');
  writeFileSync(promptPath, '请用 Bash 工具执行命令 echo vibe-ok，除此之外什么都不要做，不要读文件、不要重试，完成后立即结束回复。', 'utf8');
  const command = [
    'claude', '-p', '--settings', settingsPath, '--mcp-config', mcpPath,
    '--permission-mode', 'manual',
    '--permission-prompt-tool', 'mcp__vibeperm__permission_prompt',
    '<', promptPath,
    extraArgs,
  ].join(' ');
  // targeted start: without windowId the hub broadcasts and EVERY bound
  // window starts a terminal (observed duplicate claude sessions per binding)
  send({ t: 'test-control', action: 'start-session', binding, cwd, command, duplicateName, windowId: sandboxWindowIds.get(sandbox) || '' });
  return { settingsPath, mcpPath };
}

import { writeFileSync } from 'node:fs';
import os from 'node:os';
function makeSessionSettings(binding) {
  const fwd = path.join(ROOT, 'src/hook-forwarder/forward.mjs').replace(/\\/g, '/');
  // Sync + argv routing: settings "env" blocks are NOT inherited by hook
  // subprocesses and async hooks die with short -p sessions (observed
  // 2.1.286 — same fix as capture-samples.mjs). The extension's terminal
  // env injection stays as a second routing path for real sessions.
  const mk = () => [{ hooks: [{ type: 'command', command: `node ${fwd} --binding ${binding}`, timeout: 10 }] }];
  return {
    // THE forcing rule: --permission-mode manual alone does NOT prompt for
    // low-risk Bash (observed: echo ran straight through under cmd /c);
    // permissions.ask is what makes the prompt appear (same as capture).
    permissions: { ask: ['Bash(echo vibe-ok)'] },
    hooks: {
      SessionStart: mk(), UserPromptSubmit: mk(), PreToolUse: mk(),
      PermissionRequest: mk(), PostToolUse: mk(), PostToolUseFailure: mk(),
      PermissionDenied: mk(), Stop: mk(), StopFailure: mk(), Notification: mk(),
      SessionEnd: mk(),
    },
  };
}
function makeMcpConfig(binding) {
  const srv = path.join(ROOT, 'tests/mcp-permission-server.mjs').replace(/\\/g, '/');
  return {
    mcpServers: {
      vibeperm: {
        command: 'node',
        args: [srv, '--binding', binding, '--default', 'allow', '--wait-ms', '45000'],
      },
    },
  };
}
function writeTemp(name, obj) {
  const p = path.join(os.tmpdir(), `vibe-g0-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ---------------------------------------------------------------- main flow

const csvPath = path.join(ROOT, 'docs/evidence/phase1/runs', `g0-auto-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`);

async function main() {
  mkdirSync(path.dirname(csvPath), { recursive: true });
  if (!NOLAUNCH) await launchWindows();
  const autoOk = await autoBindWindows().catch(() => false);
  if (!autoOk) bindWindows();
  const okBoth = await waitFor(() => windows.size >= 2 && [...windows.values()].every((w) => w.hwnd), 240000, 500);
  if (!okBoth) {
    console.error('[run-g0] 两窗口未完成绑定（需要手动执行 Vibe: 绑定本窗口），退出');
    process.exit(2);
  }
  console.log(`[run-g0] windows bound: ${[...windows.values()].length}`);

  const groups = [];
  if (GROUP === 'same' || GROUP === 'both') groups.push('same-window');
  if (GROUP === 'cross' || GROUP === 'both') groups.push('cross-window');

  for (const g of groups) {
    console.log(`\n===== group ${g} =====`);
    for (let i = 0; i < RUNS; i++) {
      const scenario = pickScenario(g, i);
      await runOnce(g, i, scenario);
      await sleep(1200);
    }
  }

  summarize();
  if (!KEEP) send({ t: 'test-control', action: 'shutdown-hint' });
}

function pickScenario(group, i) {
  // deterministic mix: every 5th run has a special precondition
  const m = i % 5;
  if (m === 3) return { name: 'duplicate-name', duplicateName: true };
  if (m === 4) return { name: 'minimized' };
  return { name: 'plain' };
}

let runCounter = 0;

async function runOnce(group, i, scenario) {
  runCounter += 1;
  const runId = `${group}-${String(i + 1).padStart(2, '0')}`;
  const binding = `g0${Math.random().toString(16).slice(2, 8)}`;
  const sandbox = group === 'same-window' ? 'sandbox-A' : (i % 2 === 0 ? 'sandbox-A' : 'sandbox-B');

  const vBefore = latestSnapshot?.v ?? 0;
  const started = Date.now();
  await startSessionIn(binding, sandbox, { duplicateName: !!scenario.duplicateName });

  // wait for the waiting card for THIS binding
  const waiting = await waitFor(() => {
    const c = latestSnapshot?.current;
    return c && c.binding === binding && c.stateKey === 'waiting' ? latestSnapshot : null;
  }, 90000);
  if (!waiting) {
    console.log(`  ${runId} [${scenario.name}] NO-WAITING-CARD (bind ${binding})`);
    appendFileSync(csvPath, `${runId},${scenario.name},no-waiting-card,${binding},,,,,,,,,\n`);
    return;
  }
  const waitMs = Date.now() - started;

  if (scenario.name === 'minimized') {
    const w = ownerWindowOf(binding);
    if (w?.hwnd) send({ t: 'test-control', action: 'minimize-window', hwnd: w.hwnd });
    await sleep(700);
  }

  // trigger the big key through the same handler the physical hotkey uses
  const res = await bigkey(runId);
  const row = res ? `${runId},${scenario.name},${res.outcome},${binding},${res.vAtPress},${res.t0},${res.t1 ?? ''},${res.t2 ?? ''},${res.msReceipt ?? ''},${res.msVerified ?? ''},${res.activeTerminal},${res.terminalName}` : `${runId},${scenario.name},fail,${binding},,,,,,,,,`;

  // release the permission decision (the "user handled it" step)
  send({ t: 'mcp-allow', binding }); // broadcast by the hub; waiters filter by binding
  await sleep(400);

  // wait for card cleared (Stop/session-end) then dispose terminal
  await waitFor(() => {
    const c = latestSnapshot?.current;
    return (!c || c.binding !== binding) ? true : null;
  }, 30000);
  send({ t: 'test-control', action: 'dispose-terminal', binding });

  console.log(`  ${runId} [${scenario.name}] wait=${waitMs}ms → ${res?.outcome} verified=${res?.msVerified ?? '-'}ms`);
  appendFileSync(csvPath, row + '\n');
}

function ownerWindowOf(binding) {
  for (const [wid, w] of windows) if (w.terminals.has(binding)) return { windowId: wid, ...w };
  return null;
}

function bigkey(runId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 4000);
    on('run-result', (r) => { if (r.runId === runId) { clearTimeout(t); resolve(r); } });
    send({ t: 'bigkey', src: 'pipe', runId });
  });
}

function summarize() {
  console.log('\n===== summary =====');
  const rows = runResults;
  const auto = rows.filter((r) => r.outcome === 'auto');
  const denied = rows.filter((r) => r.outcome === 'activation-denied');
  const fail = rows.filter((r) => r.outcome !== 'auto' && r.outcome !== 'activation-denied');
  const p95 = percentile(auto.map((r) => r.msVerified).filter(Boolean));
  console.log(`runs=${rows.length} auto=${auto.length} activation-denied=${denied.length} fail=${fail.length}`);
  console.log(`auto P95 (key→foreground-verified): ${p95 ?? '-'} ms`);
  for (const f of fail) console.log(`  FAIL ${f.runId}: ${f.outcome}`);
  console.log(`csv -> ${csvPath}`);
}

function percentile(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.95 * s.length) - 1];
}

main().catch((e) => { console.error(e); process.exit(1); });
