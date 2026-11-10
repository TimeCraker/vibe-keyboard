#!/usr/bin/env node
/**
 * MCP stdio server acting as the official permission host for automated
 * Claude Code test sessions (claude -p --permission-prompt-tool ...).
 *
 * Every permission decision flows through this server over Claude Code's
 * official permission channel — the same path a human IDE approval takes.
 * The server coordinates with the vibe-keyboard host pipe:
 *   - notifies "mcp-waiting" when a prompt arrives
 *   - waits for "mcp-resolved" (allow/deny) from the test runner, or a
 *     timeout fallback, then returns the decision.
 *
 * Usage: node mcp-permission-server.mjs --binding <id> [--default allow|deny]
 *        [--wait-ms 60000] [--pipe \\\\.\pipe\vibe-keyboard-hub]
 */
import net from 'node:net';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const BINDING = arg('binding', '');
const DEFAULT = arg('default', 'allow'); // fallback decision
const WAIT_MS = Number(arg('wait-ms', 60000));
const PIPE = arg('pipe', '\\\\.\\pipe\\vibe-keyboard-hub');

// --- host pipe client (for coordination only) ------------------------------
let hub;
function hubConnect() {
  hub = net.connect(PIPE);
  hub.on('error', () => { hub = undefined; });
  hub.on('close', () => { hub = undefined; });
}
hubConnect();
function hubSend(obj) {
  try { hub?.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
}

// --- MCP stdio JSON-RPC ------------------------------------------------------
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function notify(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'vibe-permission', version: '0.1.0' },
    });
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  } else if (msg.method === 'tools/list') {
    reply(msg.id, {
      tools: [{
        name: 'permission_prompt',
        description: 'Vibe test permission host: answers Claude Code permission prompts.',
        inputSchema: { type: 'object', properties: { tool_name: { type: 'string' } }, required: ['tool_name'] },
      }],
    });
  } else if (msg.method === 'tools/call') {
    const tool = msg.params?.name;
    if (tool !== 'permission_prompt') {
      reply(msg.id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true });
      return;
    }
    hubSend({ t: 'mcp-waiting', binding: BINDING, ts: Date.now() });
    const started = Date.now();
    let settled = false;
    const finish = (behavior, message) => {
      if (settled) return;
      settled = true;
      hubSend({ t: 'mcp-resolved', binding: BINDING, behavior, ts: Date.now() });
      reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(message ? { behavior, message } : { behavior }) }] });
    };
    if (hub) {
      let hbuf = '';
      hub.on('data', (d) => {
        hbuf += d.toString('utf8');
        let i;
        while ((i = hbuf.indexOf('\n')) >= 0) {
          const l = hbuf.slice(0, i).trim();
          hbuf = hbuf.slice(i + 1);
          if (!l) continue;
          try {
            const m = JSON.parse(l);
            const mine = !m.binding || m.binding === BINDING;
            if (m.t === 'mcp-allow' && mine) finish('allow');
            else if (m.t === 'mcp-deny' && mine) finish('deny', 'vibe test deny');
          } catch { /* ignore */ }
        }
      });
    }
    // fallback: default decision after waiting for the focus test window
    setTimeout(() => finish(DEFAULT), WAIT_MS);
    notify('notifications/vibe/waiting', { binding: BINDING, started });
  } else if (msg.id !== undefined) {
    reply(msg.id, {});
  }
}
