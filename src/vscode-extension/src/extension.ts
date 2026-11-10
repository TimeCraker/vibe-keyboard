import * as vscode from 'vscode';
import * as net from 'net';
import { randomUUID } from 'crypto';

/**
 * Vibe Keyboard VS Code extension (S0).
 *
 * Owns terminal instances. One extension-host connection to the vibe-keyboard
 * host pipe per window instance. Never owns business state: the queue, the
 * screen and focus policy all live in the host.
 */

const PIPE = process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';
const AUTOTEST = process.env.VIBE_AUTOTEST === '1';

interface ManagedTerminal {
  binding: string;
  terminal: vscode.Terminal;
  name: string;
}

interface HostMessage {
  t: string;
  [k: string]: unknown;
}

let output: vscode.OutputChannel;
let client: net.Socket | undefined;
let connected = false;
let windowId = '';
let boundHwnd = 0;
let disposed = false;
const terminals = new Map<string, ManagedTerminal>();
const seenReqIds = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Vibe Keyboard');
  context.subscriptions.push(output);

  windowId = randomUUID();

  context.subscriptions.push(
    vscode.commands.registerCommand('vibe.startSession', () => startSessionCommand()),
    vscode.commands.registerCommand('vibe.bindWindow', () => bindWindowCommand()),
    vscode.commands.registerCommand('vibe.showStatus', () => showStatus()),
    vscode.window.onDidCloseTerminal((t) => onTerminalClosed(t)),
  );

  connect();
}

export function deactivate(): void {
  disposed = true;
  try { client?.destroy(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- pipe client

function connect(): void {
  if (disposed) return;
  const sock = net.connect(PIPE);
  let buf = '';
  sock.setEncoding('utf8');

  sock.on('connect', () => {
    connected = true;
    send({ t: 'hello', role: 'extension', windowId, vscode: vscode.version, pid: process.pid });
    if (boundHwnd) {
      send({ t: 'window-bound', windowId, hwnd: boundHwnd, focused: true, processName: 'Code' });
    }
    for (const mt of terminals.values()) {
      send({ t: 'terminal', windowId, binding: mt.binding, name: mt.name, action: 'add' });
    }
    output.appendLine(`[vibe] host connected (window ${windowId.slice(0, 8)})`);
  });

  sock.on('data', (chunk) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: HostMessage | undefined;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg) onHostMessage(msg);
    }
  });

  const drop = () => {
    if (connected) output.appendLine('[vibe] host disconnected, retrying');
    connected = false;
    try { sock.destroy(); } catch { /* ignore */ }
    setTimeout(connect, 2000);
  };
  sock.on('error', drop);
  sock.on('close', drop);

  client = sock;
}

function send(msg: Record<string, unknown>): void {
  if (!client || !connected) return;
  try { client.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
}

function onHostMessage(msg: HostMessage): void {
  switch (msg.t) {
    case 'focus-request': {
      const reqId = String(msg.reqId || '');
      const binding = String(msg.binding || '');
      if (seenReqIds.has(reqId)) return; // no replays across reconnects
      seenReqIds.add(reqId);
      if (seenReqIds.size > 512) seenReqIds.clear();
      void handleFocusRequest(reqId, binding);
      break;
    }
    case 'test-control':
      if (AUTOTEST) handleTestControl(msg);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------- commands

async function startSessionCommand(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    void vscode.window.showWarningMessage('Vibe: 请先打开一个文件夹作为会话工作区');
    return;
  }
  const binding = newBinding();
  await createManagedTerminal({
    binding,
    cwd: folder,
    interactive: true,
    duplicateName: false,
  });
  void vscode.window.showInformationMessage(`Vibe: 受管会话已启动（绑定 ${binding}）`);
}

async function bindWindowCommand(): Promise<void> {
  const focused = vscode.window.state.focused;
  if (!focused) {
    void vscode.window.showWarningMessage('Vibe: 绑定需要本窗口处于前台，请重试');
    return;
  }
  const info = await captureForegroundWindow();
  if (!info) {
    void vscode.window.showWarningMessage('Vibe: 无法采集前台窗口句柄');
    return;
  }
  if (!/^Code/i.test(info.processName)) {
    void vscode.window.showWarningMessage(`Vibe: 前台进程 ${info.processName} 不是 VS Code，拒绝绑定`);
    return;
  }
  boundHwnd = info.hwnd;
  send({ t: 'window-bound', windowId, hwnd: boundHwnd, focused, processName: info.processName });
  void vscode.window.showInformationMessage(`Vibe: 窗口已绑定 (HWND ${boundHwnd})`);
}

function showStatus(): void {
  output.show();
  output.appendLine(`windowId: ${windowId}`);
  output.appendLine(`host: ${connected ? 'connected' : 'disconnected'} (${PIPE})`);
  output.appendLine(`hwnd: ${boundHwnd || '(未绑定)'}`);
  output.appendLine(`autotest: ${AUTOTEST}`);
  for (const mt of terminals.values()) {
    output.appendLine(`terminal: ${mt.name} binding=${mt.binding} exit=${mt.terminal.exitStatus !== undefined}`);
  }
}

// -------------------------------------------------------------- terminal mgmt

function newBinding(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

async function createManagedTerminal(opts: {
  binding: string;
  cwd: string;
  interactive: boolean;
  duplicateName: boolean;
  command?: string;
}): Promise<ManagedTerminal | undefined> {
  const label = opts.duplicateName ? 'vibe (claude)' : `vibe ${opts.binding} (claude)`;
  const command = opts.command || 'claude';
  // cmd /k keeps the shell alive for interactive sessions; /c for scripted
  // (-p) runs that terminate by themselves.
  const shellArgs = opts.interactive
    ? ['/d', '/s', '/c', `${command} & echo. & echo [vibe] 会话已退出，可关闭此终端`]
    : ['/d', '/s', '/c', command];

  const terminal = vscode.window.createTerminal({
    name: label,
    shellPath: process.env.ComSpec || 'cmd.exe',
    shellArgs,
    cwd: opts.cwd,
    env: { VIBE_BINDING_ID: opts.binding, VIBE_PIPE: PIPE },
  });
  const mt: ManagedTerminal = { binding: opts.binding, terminal, name: label };
  terminals.set(opts.binding, mt);
  send({ t: 'terminal', windowId, binding: opts.binding, name: label, action: 'add' });
  terminal.show(false);
  return mt;
}

function onTerminalClosed(t: vscode.Terminal): void {
  for (const [binding, mt] of terminals) {
    if (mt.terminal === t) {
      terminals.delete(binding);
      send({ t: 'terminal', windowId, binding, name: mt.name, action: 'remove' });
      return;
    }
  }
}

// ---------------------------------------------------------------- focus flow

async function handleFocusRequest(reqId: string, binding: string): Promise<void> {
  const mt = terminals.get(binding);
  if (!mt) {
    send({
      t: 'focus-receipt', reqId, binding, shown: false,
      terminalName: '', activeTerminal: '', err: 'binding-not-found',
    });
    return;
  }
  mt.terminal.show(false);
  // Give VS Code a beat to update the active terminal, then report what is
  // actually selected — the host decides, we do not claim success blindly.
  await new Promise((r) => setTimeout(r, 150));
  const active = vscode.window.activeTerminal;
  send({
    t: 'focus-receipt',
    reqId,
    binding,
    shown: true,
    terminalName: mt.name,
    activeTerminal: active ? active.name : '',
    err: active && active.name === mt.name ? '' : 'active-terminal-mismatch',
  });
}

// ------------------------------------------------------------- window capture

interface ForegroundInfo { hwnd: number; pid: number; processName: string }

async function captureForegroundWindow(): Promise<ForegroundInfo | undefined> {
  const ps = [
    'Add-Type @"',
    'using System;using System.Runtime.InteropServices;',
    'public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}',
    '"@',
    '$h=[W]::GetForegroundWindow();$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);',
    '$pn=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;',
    '"{0}|{1}|{2}" -f $h.ToInt64(),$p,$pn',
  ].join('\n');
  try {
    const res = await new Promise<string>((resolve, reject) => {
      const cp = require('node:child_process').spawn(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true },
      );
      let out = '';
      cp.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      cp.on('close', () => resolve(out.trim()));
      cp.on('error', reject);
    });
    const [hwnd, pid, processName] = res.split('|');
    const n = Number(hwnd);
    if (!Number.isFinite(n) || n <= 0 || !processName) return undefined;
    return { hwnd: n, pid: Number(pid), processName };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ autotest

function handleTestControl(msg: HostMessage): void {
  const action = String(msg.action || '');
  if (action === 'start-session') {
    const binding = String(msg.binding || newBinding());
    void createManagedTerminal({
      binding,
      cwd: String(msg.cwd || ''),
      interactive: false,
      duplicateName: Boolean(msg.duplicateName),
      command: String(msg.command || 'claude -p test'),
    }).then((mt) => {
      if (mt) send({ t: 'test-ack', action, binding, windowId });
    });
  } else if (action === 'bind-now') {
    // Automated window binding: the runner activates this window first, so
    // the same checks as the manual command apply (focused + VS Code process).
    void bindWindowCommand();
  } else if (action === 'bind-force') {
    // AUTOTEST-only, lock-screen-safe binding: the runner supplies the hwnd
    // it matched by window title; we verify it points at THIS workspace and
    // accept it without the foreground check (SetForegroundWindow is denied
    // system-wide while the session is locked / no window is foreground).
    const ws = String(msg.workspace || '');
    const mine = vscode.workspace.name || '';
    if (ws && mine.includes(ws)) {
      boundHwnd = Number(msg.hwnd || 0);
      send({ t: 'window-bound', windowId, hwnd: boundHwnd, focused: vscode.window.state.focused, processName: 'Code (autotest)' });
    }
  } else if (action === 'dispose-terminal') {
    const binding = String(msg.binding || '');
    const mt = terminals.get(binding);
    if (mt) {
      mt.terminal.dispose();
      terminals.delete(binding);
      send({ t: 'terminal', windowId, binding, name: mt.name, action: 'remove' });
    }
  }
}
