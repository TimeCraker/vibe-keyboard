#!/usr/bin/env node
/**
 * Vibe Keyboard host (S0, Node.js implementation).
 *
 * Modes:
 *   serve  Run the hub: named pipe, state machine, simulated screen, global
 *          hotkey (Ctrl+Alt+V by default), console big-key (Enter), run CSV.
 *   replay <fixtures.jsonl>
 *          Feed sanitized hook events through the state machine and print
 *          transitions + final snapshot as JSONL (used by replay tests).
 *   status One-shot snapshot query against a running hub.
 *
 * Env overrides: VIBE_PIPE, VIBE_HOTKEY_MODS, VIBE_HOTKEY_VK,
 *                VIBE_EXPIRE_MIN, VIBE_EVIDENCE_DIR
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateMachine } from './lib/statemachine.mjs';
import { SimScreen } from './lib/screen.mjs';
import { Hub, PIPE_NAME } from './lib/hub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = process.env.VIBE_EVIDENCE_DIR || path.join(ROOT, 'docs/evidence/phase1');
const MODE = process.argv[2] || 'serve';

// ------------------------------------------------------------------- replay

if (MODE === 'replay') {
  const file = process.argv[3];
  if (!file || !existsSync(file)) {
    console.error('usage: node host.mjs replay <fixtures.jsonl>');
    process.exit(2);
  }
  const { claudeCodeAdapter } = await import('./lib/adapters.mjs');
  const sm = new StateMachine({
    onTransition: (tr) => process.stdout.write(JSON.stringify({ t: 'transition', ...tr }) + '\n'),
    onSnapshot: (snap) => process.stdout.write(JSON.stringify({ t: 'snapshot', ...snap }) + '\n'),
  });
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    let raw;
    try { raw = JSON.parse(l); } catch { continue; }
    const unified = raw.src === 'codex'
      ? (await import('./lib/adapters.mjs')).codexAdapter(raw)
      : claudeCodeAdapter(raw);
    if (unified) sm.apply(unified);
  }
  process.stdout.write(JSON.stringify({ t: 'final', snapshot: sm.snapshot() }) + '\n');
  process.exit(0);
}

// ------------------------------------------------------------------- status

if (MODE === 'status') {
  const sock = net.connect(PIPE_NAME);
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('connect', () => sock.write(JSON.stringify({ t: 'status' }) + '\n'));
  sock.on('data', (d) => {
    buf += d;
    const i = buf.indexOf('\n');
    if (i >= 0) {
      process.stdout.write(buf.slice(0, i + 1));
      sock.destroy();
      process.exit(0);
    }
  });
  const to = setTimeout(() => { console.error('hub not responding on ' + PIPE_NAME); process.exit(1); }, 1500);
  to.unref();
  sock.on('error', () => { console.error('cannot connect to ' + PIPE_NAME); process.exit(1); });
  process.exit(0);
}

// -------------------------------------------------------------------- serve

const expireMin = Number(process.env.VIBE_EXPIRE_MIN || 10);
mkdirSync(path.join(EVIDENCE, 'runs'), { recursive: true });
const runsCsv = path.join(EVIDENCE, 'runs', `g0-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`);
if (!existsSync(runsCsv)) {
  appendFileSync(runsCsv, 'runId,src,outcome,binding,vAtPress,t0,t1,t2,msReceipt,msVerified,activeTerminal,terminalName\n');
}
const snapJsonl = path.join(EVIDENCE, 'screen-snapshots.jsonl');

const isTTY = process.stdout.isTTY;
const sm = new StateMachine({
  expireMs: expireMin * 60 * 1000,
  // dual sink: render the simulated screen AND push the snapshot to every
  // hub client (runners gate acceptance steps on latestSnapshot; without
  // the push they only ever see the initial snapshot from their hello)
  onSnapshot: (snap) => { screen.update(snap); hub?.broadcastSnap(snap); },
});
const screen = new SimScreen({ jsonlPath: snapJsonl, render: isTTY });

// ---- win32 sidecar ---------------------------------------------------------
const win32OpsPath = path.join(ROOT, 'scripts/ps/win32ops-sidecar.ps1');
const win32p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win32OpsPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let wbuf = '';
const wwaiters = [];
win32p.stdout.setEncoding('utf8');
win32p.stdout.on('data', (d) => {
  wbuf += d;
  let i;
  while ((i = wbuf.indexOf('\n')) >= 0) {
    const l = wbuf.slice(0, i).trim();
    wbuf = wbuf.slice(i + 1);
    if (!l) continue;
    const w = wwaiters.shift();
    if (w) w(l);
  }
});
win32p.stderr.setEncoding('utf8');
win32p.stderr.on('data', (d) => { if (d.trim()) process.stderr.write('[win32:err] ' + d); });
function wcmd(line) {
  return new Promise((resolve) => {
    wwaiters.push(resolve);
    win32p.stdin.write(line + '\n');
    setTimeout(() => {
      // unblock even without reply (reply consumed by next round otherwise)
      const idx = wwaiters.indexOf(resolve);
      if (idx >= 0) { wwaiters.splice(idx, 1); resolve('TIMEOUT'); }
    }, 3000).unref?.();
  });
}
const win32 = {
  async activate(hwnd) {
    const r = await wcmd(`activate ${hwnd}`);
    const [, setfg = '0', isfg = '0'] = r.split('|');
    return { setFg: setfg === '1', isFg: isfg === '1' };
  },
  async activateAttach(hwnd) {
    const r = await wcmd(`activate_attach ${hwnd}`);
    const [, setfg = '0', isfg = '0'] = r.split('|');
    return { setFg: setfg === '1', isFg: isfg === '1' };
  },
  async foreground() {
    const r = await wcmd('foreground');
    const [, hwnd = '0', pid = '0', proc = ''] = r.split('|');
    return { hwnd: Number(hwnd), pid: Number(pid), proc };
  },
  async minimize(hwnd) { await wcmd(`minimize ${hwnd}`); },
};

// ---- hub + run log ---------------------------------------------------------
const hooksRaw = path.join(EVIDENCE, 'hooks-received.jsonl');
const hub = new Hub({
  stateMachine: sm,
  screen,
  win32,
  onHook: (msg) => { try { appendFileSync(hooksRaw, JSON.stringify(msg) + '\n'); } catch { /* */ } },
  onRunResult: (row) => {
    appendFileSync(runsCsv, [row.runId, row.src, row.outcome, row.binding, row.vAtPress, row.t0, row.t1 ?? '', row.t2 ?? '', row.msReceipt ?? '', row.msVerified ?? '', csv(row.activeTerminal), csv(row.terminalName)].join(',') + '\n');
    hubLog(`run ${row.runId} [${row.src}] ${row.outcome} verified=${row.msVerified ?? '-'}ms`);
  },
});
function hubLog(l) { if (!isTTY) console.log('[hub] ' + l); }
function csv(s) { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

hub.start();

// ---- hotkey sidecar --------------------------------------------------------
const hotkeyPath = path.join(ROOT, 'scripts/ps/hotkey-sidecar.ps1');
const mods = process.env.VIBE_HOTKEY_MODS || 'CTRL,ALT,NOREPEAT';
const vk = process.env.VIBE_HOTKEY_VK || '0x56';
let hotkeyChild = null;
if (process.env.VIBE_NO_HOTKEY !== '1') {
  hotkeyChild = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hotkeyPath, '-Mods', mods, '-Vk', vk], { stdio: ['ignore', 'pipe', 'pipe'] });
  let hbuf = '';
  hotkeyChild.stdout.setEncoding('utf8');
  hotkeyChild.stdout.on('data', (d) => {
    hbuf += d;
    let i;
    while ((i = hbuf.indexOf('\n')) >= 0) {
      const l = hbuf.slice(0, i).trim();
      hbuf = hbuf.slice(i + 1);
      if (l === 'HOTKEY_PRESSED') {
        void hub.bigKey('hotkey');
      } else if (l === 'HOTKEY_REGISTER_FAILED') {
        hubLog('hotkey register failed (busy?); pipe/console triggers still work');
      } else if (l === 'HOTKEY_READY') {
        hubLog(`hotkey ready (${mods.replace(',NOREPEAT', '')}+VK${vk})`);
      }
    }
  });
  hotkeyChild.stderr.setEncoding('utf8');
  hotkeyChild.stderr.on('data', (d) => { if (d.trim()) process.stderr.write('[hotkey:err] ' + d); });
}

// ---- console big key + lifecycle -------------------------------------------
if (isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => {
    if (d[0] === 13 || d[0] === 32) void hub.bigKey('console'); // Enter/Space
    if (d[0] === 3 || d[0] === 113) shutdown();                  // Ctrl+C / q
  });
} else {
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}

function shutdown() {
  hubLog('shutting down');
  try { win32p.stdin.write('quit\n'); } catch { /* */ }
  setTimeout(() => { try { win32p.kill(); } catch { /* */ } try { hotkeyChild?.kill(); } catch { /* */ } screen.close(); process.exit(0); }, 200);
}

if (!isTTY) console.log(`[vibe-host] serving ${PIPE_NAME} | expire=${expireMin}min | csv=${path.relative(ROOT, runsCsv)}`);
