#!/usr/bin/env node
/**
 * Codex PermissionRequest hook (S0 Codex mixed validation).
 *
 * Wired from <sandbox>/.codex/hooks.json (project layer, reversible by
 * deleting the file; user config.toml untouched). Two jobs:
 *   1. report the waiting signal to the vibe hub (same shape as the Claude
 *      Code MCP permission server's mcp-waiting), routed by --binding
 *   2. hold the decision until the hub says mcp-allow / mcp-deny (the
 *      "user handled it after jumping back" step), then answer Codex via
 *      stdout JSON — the documented PermissionRequest hook decision shape.
 *
 * Times out to --default after --wait-ms (mirrors mcp-permission-server).
 */
import net from 'node:net';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}
const PIPE = argOf('--pipe') || '\\\\.\\pipe\\vibe-keyboard-hub';
const BINDING = argOf('--binding') || process.env.VIBE_BINDING_ID || '';
const DEFAULT = argOf('--default') || 'allow';
const WAIT_MS = Number(argOf('--wait-ms') || 45000);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => answer(DEFAULT));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw); } catch { answer(DEFAULT); return; }

  const evt = {
    t: 'hook',
    src: 'codex',
    binding: BINDING,
    session: typeof payload.session_id === 'string' ? payload.session_id : '',
    event: 'PermissionRequest',
    tool: typeof payload.tool_name === 'string' ? payload.tool_name : '',
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : '',
    notifyType: '',
    stopReason: '',
    errorKind: '',
    cwdName: typeof payload.cwd === 'string' ? payload.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '' : '',
    ts: Date.now(),
    fwdMs: 0,
  };

  const sock = net.connect(PIPE);
  let decision = '';
  const finish = () => answer(decision || DEFAULT);
  const timer = setTimeout(() => { try { sock.destroy(); } catch {} finish(); }, WAIT_MS);

  sock.on('connect', () => {
    // report waiting + subscribe for the release signal
    sock.write(JSON.stringify(evt) + '\n');
    sock.write(JSON.stringify({ t: 'mcp-waiting', binding: BINDING, tool: evt.tool, session: evt.session }) + '\n');
  });
  sock.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      let m = null;
      try { m = JSON.parse(line); } catch { continue; }
      // mcp-allow/deny are BROADCAST by the hub to all permission waiters —
      // only accept decisions addressed to this binding
      const mine = !m.binding || m.binding === BINDING;
      if (m.t === 'mcp-allow' && mine) { decision = 'allow'; break; }
      if (m.t === 'mcp-deny' && mine) { decision = 'deny'; break; }
    }
    if (decision) { clearTimeout(timer); try { sock.end(); } catch {} finish(); }
  });
  sock.on('error', () => { clearTimeout(timer); finish(); });
  sock.on('close', () => { if (!decision) { clearTimeout(timer); finish(); } });
});

function answer(behavior) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior },
    },
  }));
  process.exit(0);
}
