#!/usr/bin/env node
/**
 * Codex mixed validation (S0 extension task, listed separately per spec).
 *
 * One VS Code window, two managed terminals in the SAME window:
 *   1. claude terminal  — waiting via Claude Code PermissionRequest + MCP
 *      permission server (the official --permission-prompt-tool channel)
 *   2. codex terminal   — waiting via Codex hooks.json PermissionRequest +
 *      codex-permission-hook.mjs decision channel
 *
 * Flow per phase: both waitings enqueue -> big key jumps to the OLDEST one
 * (receipt must select the right terminal) -> mcp-allow{binding} releases it
 * -> next waiting becomes current -> big key again -> release. Everything
 * except OS window activation works while the session is locked
 * (activation-denied is tallied separately).
 *
 * Usage: node tests/run-codex-mixed.mjs [--keep]
 * Requires: host.mjs serve running; one VS Code window open on sandbox-A
 * with VIBE_AUTOTEST=1 (run-g0's launcher produces it).
 */
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIPE = process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';
const KEEP = process.argv.includes('--keep');

// ------------------------------------------------------------------ hub conn
const sock = net.connect(PIPE);
let buf = '';
const handlers = new Map();
const on = (t, fn) => { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn); };
const onAny = (fn) => { on('*', fn); };
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
function send(o) { sock.write(JSON.stringify(o) + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}
sock.write(JSON.stringify({ t: 'hello', role: 'runner' }) + '\n');

const windows = new Map();
let latestSnapshot = null;
const receipts = new Map();
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
on('snapshot', (m) => { latestSnapshot = m; });
on('focus-receipt', (m) => { receipts.set(m.reqId, m); });
onAny((m) => {
  if (m.t === 'mcp-waiting') console.log(`  [mcp-waiting] binding=${m.binding} tool=${m.tool}`);
});

// ------------------------------------------------------------------ helpers
const PS1 = path.join(ROOT, 'scripts/ps/activate-window.ps1');
function hwndOfTitle(part) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-List'],
    { encoding: 'utf8', timeout: 15000 });
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+) \| (.+)$/);
    if (m && m[2].includes(part)) return Number(m[1]);
  }
  return 0;
}

function tmpWrite(name, obj) {
  const p = path.join(os.tmpdir(), `vibe-mix-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

async function bindForce(sb) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const hwnd = hwndOfTitle(sb);
    if (hwnd) {
      send({ t: 'test-control', action: 'bind-force', workspace: sb, hwnd });
      await sleep(1500);
      const entry = [...windows.entries()].find(([, w]) => w.hwnd === hwnd);
      if (entry) return { hwnd, windowId: entry[0] };
    } else {
      await sleep(2000);
    }
  }
  return null;
}

async function startTerminal(binding, cwd, command, windowId) {
  // targeted: broadcast start-session would create the terminal in EVERY
  // bound window
  send({ t: 'test-control', action: 'start-session', binding, cwd, command, duplicateName: false, windowId });
}

async function bigkey(runId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    on('run-result', (r) => { if (r.runId === runId) { clearTimeout(timer); resolve(r); } });
    send({ t: 'bigkey', src: 'pipe', runId });
  });
}

// ------------------------------------------------------------------ session configs
function claudeCommand(binding) {
  const fwd = path.join(ROOT, 'src/hook-forwarder/forward.mjs').replace(/\\/g, '/');
  const hook = `node ${fwd} --binding ${binding}`;
  const mk = () => [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }];
  const settings = tmpWrite(`settings-${binding}`, {
    permissions: { ask: ['Bash(echo vibe-ok)'] },
    hooks: {
      SessionStart: mk(), UserPromptSubmit: mk(), PreToolUse: mk(),
      PermissionRequest: mk(), PostToolUse: mk(), PostToolUseFailure: mk(),
      PermissionDenied: mk(), Stop: mk(), StopFailure: mk(), Notification: mk(),
      SessionEnd: mk(),
    },
  });
  const srv = path.join(ROOT, 'tests/mcp-permission-server.mjs').replace(/\\/g, '/');
  const mcp = tmpWrite(`mcp-${binding}`, {
    mcpServers: { vibeperm: { command: 'node', args: [srv, '--binding', binding, '--default', 'allow', '--wait-ms', '45000'] } },
  });
  const prompt = tmpWrite(`prompt-${binding}`, '请用 Bash 工具执行命令 `echo vibe-ok`，除此之外什么都不要做，完成后立即结束回复。').replace(/\.json$/, '');
  // (tmpWrite above got a .json name; simpler: write prompt file next to settings)
  const promptFile = settings.replace(/\.json$/, '-prompt.txt');
  writeFileSync(promptFile, '请用 Bash 工具执行命令 `echo vibe-ok`，除此之外什么都不要做，完成后立即结束回复。', 'utf8');
  return `claude -p --settings ${settings} --mcp-config ${mcp} --permission-mode manual --permission-prompt-tool mcp__vibeperm__permission_prompt < ${promptFile}`;
}

function prepareCodexSandbox(binding) {
  const dir = path.join(ROOT, 'tests/fixtures/sandbox-codex');
  mkdirSync(path.join(dir, '.codex'), { recursive: true });
  const tpl = readFileSync(path.join(ROOT, 'tests/fixtures/codex-hooks-template.json'), 'utf8');
  writeFileSync(path.join(dir, '.codex/hooks.json'), tpl.replaceAll('CODEXBINDING', binding));
  const promptFile = path.join(dir, 'prompt.txt');
  // WRITE command on purpose: under -s read-only the write is blocked, which
  // forces an approval escalation -> PermissionRequest hook fires (observed:
  // plain echo runs straight through with no approval in read-only)
  writeFileSync(promptFile, '请用 shell 执行命令 echo vibe-codex-ok > proof.txt 创建文件，除此之外什么都不要做，完成后立即结束回复。', 'utf8');
  return { dir, promptFile };
}

function codexCommand(binding, promptFile) {
  // stdin prompt (no cmdline quotes); project-layer hooks need cwd = sandbox;
  // --dangerously-bypass-hook-trust skips per-hook trust for this vetted run
  return `codex exec --dangerously-bypass-hook-trust -s read-only - < ${promptFile}`;
}

// ------------------------------------------------------------------ main
const results = [];
async function phase(name, fn) {
  console.log(`\n[mix] phase: ${name}`);
  const r = await fn();
  results.push({ phase: name, ...r });
  console.log(`[mix] ${name} ->`, JSON.stringify(r));
}

async function main() {
  console.log('[mix] waiting for a bound sandbox-A window (bind-force)...');
  const win = await bindForce('sandbox-A');
  if (!win) { console.error('[mix] no sandbox-A window bound, abort'); process.exit(2); }
  console.log(`[mix] window bound: hwnd ${win.hwnd} (${win.windowId})`);

  const claudeBinding = 'mixc' + Math.random().toString(16).slice(2, 7);
  const codexBinding = 'mixx' + Math.random().toString(16).slice(2, 7);
  const claudeCwd = path.join(ROOT, 'tests/fixtures/sandbox-A');
  const codex = prepareCodexSandbox(codexBinding);

  await phase('1-enqueue-claude', async () => {
    startTerminal(claudeBinding, claudeCwd, claudeCommand(claudeBinding), win.windowId);
    const w = await waitFor(() => {
      const q = latestSnapshot?.queue;
      const cur = latestSnapshot?.current;
      return (cur && cur.binding === claudeBinding && cur.stateKey === 'waiting') || (q >= 1) ? latestSnapshot : null;
    }, 90000);
    return { ok: Boolean(w), v: w?.v };
  });

  await phase('2-enqueue-codex', async () => {
    startTerminal(codexBinding, codex.dir, codexCommand(codexBinding, codex.promptFile), win.windowId);
    const w = await waitFor(() => {
      const cur = latestSnapshot?.current;
      const q = latestSnapshot?.queue; // total todo count incl. current
      const codexWaiting = cur?.binding === codexBinding && cur.stateKey === 'waiting';
      const two = cur?.binding === claudeBinding && (q ?? 0) >= 2;
      return (codexWaiting || two) ? latestSnapshot : null;
    }, 120000);
    return { ok: Boolean(w), queue: w?.queue, current: w?.current?.binding };
  });

  await phase('3-bigkey-oldest', async () => {
    const r = await bigkey('mix-r1');
    return {
      ok: Boolean(r), outcome: r?.outcome ?? 'no-result',
      msReceipt: r?.msReceipt, activeTerminal: r?.activeTerminal, terminalName: r?.terminalName,
    };
  });

  await phase('4-release-claude', async () => {
    send({ t: 'mcp-allow', binding: claudeBinding });
    const w = await waitFor(() => {
      const cur = latestSnapshot?.current;
      return cur?.binding !== claudeBinding ? latestSnapshot : null;
    }, 60000);
    return { ok: Boolean(w), current: w?.current?.binding };
  });

  await phase('5-bigkey-codex', async () => {
    const r = await bigkey('mix-r2');
    return {
      ok: Boolean(r), outcome: r?.outcome ?? 'no-result',
      msReceipt: r?.msReceipt, activeTerminal: r?.activeTerminal, terminalName: r?.terminalName,
    };
  });

  await phase('6-release-codex', async () => {
    send({ t: 'mcp-allow', binding: codexBinding });
    const w = await waitFor(() => (latestSnapshot?.queue ?? 1) === 0 ? latestSnapshot : null, 60000);
    return { ok: Boolean(w) };
  });

  send({ t: 'test-control', action: 'dispose-terminal', binding: claudeBinding });
  send({ t: 'test-control', action: 'dispose-terminal', binding: codexBinding });

  const out = path.join(ROOT, 'docs/evidence/phase1/runs', `codex-mixed-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), claudeBinding, codexBinding, results }, null, 2));
  console.log('\n[mix] results ->', out);
  console.log('[mix] summary:', results.map((r) => `${r.phase}:${r.ok ? 'OK' : 'FAIL'}`).join('  '));
  sock.destroy();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

setTimeout(() => { console.error('[mix] global timeout'); process.exit(3); }, 8 * 60 * 1000).unref();
main();
