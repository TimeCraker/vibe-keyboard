#!/usr/bin/env node
/**
 * Vibe Keyboard hook forwarder (S0)
 *
 * Reads one Claude Code hook JSON payload from stdin and pushes a sanitized
 * event line to the vibe-keyboard host named pipe. Runs with hard internal
 * time limits so it can never block the agent, regardless of hook timeout
 * config. Never returns a permission decision; always exits 0 unless the
 * payload itself is unreadable (still exits 0 — hooks are observation only).
 *
 * Env:
 *   VIBE_BINDING_ID  injected by the VS Code extension terminal (required
 *                    for routing; events without it are dropped by the host)
 *   VIBE_PIPE        pipe path, default \\.\pipe\vibe-keyboard-hub
 *   VIBE_FORWARD_TIMEOUT_MS  overall budget, default 1200
 *
 *   argv --binding <id> / --pipe <path> override env. Needed because settings
 *   "env" blocks are NOT inherited by hook subprocesses (observed 2.1.286).
 */
import net from 'node:net';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const PIPE = argOf('--pipe') || process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';
const BUDGET_MS = Number(process.env.VIBE_FORWARD_TIMEOUT_MS || 1200);
const CONNECT_MS = 250;
const ACK_MS = 300;

const started = Date.now();
const binding = argOf('--binding') || process.env.VIBE_BINDING_ID || '';
const SRC = argOf('--src') || 'claude-code';

function finish(code) {
  try { process.exit(code); } catch { /* already exiting */ }
}

// Hard wall-clock guard: nothing past BUDGET_MS.
const guard = setTimeout(() => finish(0), BUDGET_MS);
guard.unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => finish(0));

process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { finish(0); return; }

  // Sanitize: keep only what the host needs. No prompts, no tool input
  // bodies, no transcript paths, no absolute cwd (basename only).
  const evt = {
    t: 'hook',
    src: SRC,
    binding,
    session: typeof payload.session_id === 'string' ? payload.session_id : '',
    event: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'Unknown',
    tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '',
    notifyType:
      payload.hook_event_name === 'Notification' && payload.notification_type
        ? String(payload.notification_type)
        : '',
    stopReason:
      payload.hook_event_name === 'SessionEnd' && payload.reason ? String(payload.reason) : '',
    errorKind:
      payload.hook_event_name === 'StopFailure' && payload.error ? String(payload.error) : '',
    cwdName: typeof payload.cwd === 'string' ? payload.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' : '',
    ts: Date.now(),
    fwdMs: 0,
  };
  evt.fwdMs = Date.now() - started;

  if (!evt.session && !evt.binding) finish(0); // nothing routable

  const line = JSON.stringify(evt) + '\n';
  const sock = net.connect(PIPE);
  let done = false;
  const giveUp = setTimeout(() => { if (!done) { done = true; try { sock.destroy(); } catch {} finish(0); } }, CONNECT_MS + ACK_MS);
  giveUp.unref();

  sock.on('connect', () => {
    sock.write(line, () => {
      // Wait briefly for an ack line, then leave.
      const ackTimer = setTimeout(() => { if (!done) { done = true; try { sock.end(); } catch {} finish(0); } }, ACK_MS);
      ackTimer.unref();
    });
  });
  sock.on('data', () => { if (!done) { done = true; try { sock.end(); } catch {} finish(0); } });
  sock.on('error', () => { if (!done) { done = true; finish(0); } });
  sock.on('close', () => finish(0));
});

// Empty stdin (should not happen) still terminates via 'end'.
