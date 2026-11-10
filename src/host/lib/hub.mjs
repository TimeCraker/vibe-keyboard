/**
 * Host hub (S0): named-pipe server + client registry + focus controller.
 *
 * Connection roles (first message wins):
 *  - forwarder (t:"hook")        short-lived, event in, ack out, close
 *  - extension (t:"hello")       persistent per window; focus routing target
 *  - runner/debug (t:"hello"/    persistent control clients receiving
 *    t:"bigkey"/t:"status")      snapshots and run results
 *
 * Focus flow (big key → verified foreground):
 *  1. t0 big-key handler entry (hotkey / console / pipe all call this)
 *  2. target = state machine current operable target (version-stamped)
 *  3. focus-request → extension → Terminal.show → focus-receipt (t1)
 *  4. host activates the bound HWND (SetForegroundWindow, AttachThreadInput
 *     fallback) and verifies GetForegroundWindow (t2)
 *  5. outcome: auto | activation-denied | fail:<reason>; logged per run
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { claudeCodeAdapter, codexAdapter, dshAdapter } from './adapters.mjs';

export const PIPE_NAME = process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';

export class Hub {
  /**
   * @param {{stateMachine: object, screen: object, win32: object,
   *          onRunResult?: (row: object) => void,
   *          onLog?: (line: string) => void}} deps
   */
  constructor(deps) {
    this.onHook = deps.onHook || (() => {});
    this.sm = deps.stateMachine;
    this.screen = deps.screen;
    this.win32 = deps.win32;
    this.onRunResult = deps.onRunResult || (() => {});
    this.log = deps.onLog || ((l) => process.stdout.write('[hub] ' + l + '\n'));
    /** @type {Map<net.Socket, {role: string, windowId?: string, hwnd?: number,
     *                            terminals: Map<string,string>, buf: string}>} */
    this.clients = new Map();
    this.server = null;
    this.pendingFocus = new Map(); // reqId → {resolve, timer}
  }

  start() {
    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.on('error', (e) => this.log(`pipe error: ${e.message}`));
    this.server.listen(PIPE_NAME);
    this.log(`listening on ${PIPE_NAME}`);
  }

  async stop() {
    for (const [sock] of this.clients) { try { sock.destroy(); } catch { /* */ } }
    this.clients.clear();
    await new Promise((r) => this.server?.close(() => r(null)));
  }

  onConnection(sock) {
    const c = { role: 'unknown', terminals: new Map(), buf: '' };
    this.clients.set(sock, c);
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      c.buf += chunk;
      let idx;
      while ((idx = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, idx).trim();
        c.buf = c.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.onMessage(sock, c, msg).catch((e) => this.log(`handler error: ${e.message}`));
      }
    });
    const drop = () => this.onDisconnect(sock, c);
    sock.on('error', drop);
    sock.on('close', drop);
  }

  onDisconnect(sock, c) {
    if (!this.clients.has(sock)) return;
    this.clients.delete(sock);
    if (c.role === 'extension') {
      // PRD: 断线清除旧路由。Sessions themselves stay (forwarder events may
      // still arrive); only jump routing is gone until re-registration.
      this.log(`extension window ${short(c.windowId)} disconnected (routes cleared)`);
    }
  }

  send(sock, obj) {
    try { sock.write(JSON.stringify(obj) + '\n'); } catch { /* */ }
  }

  broadcast(obj, filter) {
    for (const [sock, c] of this.clients) {
      if (filter && !filter(c)) continue;
      this.send(sock, obj);
    }
  }

  extensionClients() {
    return [...this.clients.entries()].filter(([, c]) => c.role === 'extension');
  }

  findOwnerOfBinding(binding) {
    for (const [sock, c] of this.extensionClients()) {
      if (c.terminals.has(binding)) return { sock, c };
    }
    return null;
  }

  async onMessage(sock, c, msg) {
    switch (msg.t) {
      case 'hook': {
        const unified = msg.src === 'codex' ? codexAdapter(msg)
          : msg.src === 'dsh' ? dshAdapter(msg)
          : claudeCodeAdapter(msg);
        if (unified) this.sm.apply(unified);
        this.onHook(msg);
        if (c.role === 'unknown') c.role = 'forwarder';
        this.send(sock, { t: 'ack', echoT: 'hook' });
        break;
      }

      case 'hello': {
        c.role = String(msg.role || 'runner');
        if (c.role === 'extension') {
          c.windowId = String(msg.windowId || randomUUID());
          c.vscode = msg.vscode;
          this.log(`extension window ${short(c.windowId)} connected (vscode ${c.vscode})`);
        } else {
          this.send(sock, this.sm.snapshot());
        }
        break;
      }

      case 'window-bound': {
        if (c.role !== 'extension') break;
        c.windowId = String(msg.windowId || c.windowId);
        c.hwnd = Number(msg.hwnd || 0);
        this.log(`window ${short(c.windowId)} bound to HWND ${c.hwnd} (${msg.processName})`);
        break;
      }

      case 'terminal': {
        if (c.role !== 'extension') break;
        c.windowId = String(msg.windowId || c.windowId);
        const binding = String(msg.binding || '');
        if (!binding) break;
        if (msg.action === 'add') c.terminals.set(binding, String(msg.name || ''));
        else c.terminals.delete(binding);
        break;
      }

      case 'focus-receipt': {
        const reqId = String(msg.reqId || '');
        const p = this.pendingFocus.get(reqId);
        if (p) {
          this.pendingFocus.delete(reqId);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
        break;
      }

      case 'bigkey': {
        const res = await this.bigKey(String(msg.src || 'pipe'), msg.runId ? String(msg.runId) : undefined);
        this.send(sock, res);
        break;
      }

      case 'mcp-waiting':
      case 'mcp-resolved':
        // coordination channel for automated sessions; forward to control
        // clients (runner) — they decide allow/deny via a direct client.
        this.broadcast(msg, (cl) => cl.role === 'runner' || cl.role === 'extension');
        break;

      case 'mcp-allow':
      case 'mcp-deny':
        // runner decision broadcast: mcp permission servers connect without
        // a hello so they live in role 'unknown'; route there + runner echo
        this.broadcast(msg, (cl) => cl.role === 'unknown' || cl.role === 'runner');
        break;

      case 'status':
        this.send(sock, this.sm.snapshot());
        break;

      case 'test-control': {
        const action = String(msg.action || '');
        if (action === 'minimize-window') {
          await this.win32.minimize(Number(msg.hwnd || 0));
          this.send(sock, { t: 'test-ack', action });
        } else if (action === 'bind-now' || action === 'start-session' || action === 'dispose-terminal') {
          // forward to extensions (they only act in AUTOTEST mode)
          this.broadcast({ ...msg, t: 'test-control' }, (cl) => cl.role === 'extension');
          this.send(sock, { t: 'test-ack', action, forwarded: true });
        }
        break;
      }

      default:
        break;
    }
  }

  // ------------------------------------------------------------ focus flow

  /**
   * The big key. All trigger paths (physical hotkey via sidecar, host
   * console keypress, pipe command from the runner) funnel here.
   */
  async bigKey(src, runId) {
    const t0 = Date.now();
    const target = this.sm.currentTarget();
    if (!target.ok) {
      return this.finishRun(runId || `r${t0}`, src, 'fail:no-target-' + target.reason, t0, null, {}, target.v);
    }
    const binding = target.binding;
    const owner = this.findOwnerOfBinding(binding);
    if (!owner || !owner.c.hwnd) {
      return this.finishRun(runId || `r${t0}`, src, 'fail:no-route', t0, binding, {}, target.v);
    }
    const hwnd = owner.c.hwnd;

    const reqId = randomUUID();
    const receipt = await this.requestFocus(owner.sock, reqId, binding, target.v);
    const t1 = Date.now();
    if (!receipt || receipt.shown !== true) {
      return this.finishRun(runId || `r${t0}`, src, 'fail:no-receipt', t0, binding, receipt || {}, target.v, t1);
    }
    if (receipt.binding !== binding) {
      return this.finishRun(runId || `r${t0}`, src, 'fail:wrong-binding-receipt', t0, binding, receipt, target.v, t1);
    }
    if (receipt.err) {
      return this.finishRun(runId || `r${t0}`, src, 'fail:' + receipt.err, t0, binding, receipt, target.v, t1);
    }

    // window activation + verification
    let act = await this.win32.activate(hwnd);
    if (!act.isFg) {
      const act2 = await this.win32.activateAttach(hwnd);
      if (act2.isFg) act = act2;
    }
    const t2 = Date.now();
    if (!act.isFg) {
      return this.finishRun(runId || `r${t0}`, src, 'activation-denied', t0, binding, receipt, target.v, t1, t2);
    }
    return this.finishRun(runId || `r${t0}`, src, 'auto', t0, binding, receipt, target.v, t1, t2);
  }

  requestFocus(sock, reqId, binding, snapshotV) {
    return new Promise((resolve) => {
      this.pendingFocus.set(reqId, {
        resolve,
        timer: setTimeout(() => {
          this.pendingFocus.delete(reqId);
          resolve(null);
        }, 800),
      });
      this.send(sock, { t: 'focus-request', reqId, binding, snapshotV });
    });
  }

  finishRun(runId, src, outcome, t0, binding, receipt, extra, vAtPress, t1, t2) {
    const row = {
      runId, src, outcome,
      binding: binding || '',
      vAtPress,
      t0, t1: t1 ?? null, t2: t2 ?? null,
      msReceipt: t1 != null ? t1 - t0 : null,
      msVerified: t2 != null ? t2 - t0 : null,
      activeTerminal: receipt?.activeTerminal || '',
      terminalName: receipt?.terminalName || '',
    };
    this.onRunResult(row);
    this.broadcast({ t: 'run-result', ...row }, (c) => c.role === 'runner' || c.role === 'extension');
    return { t: 'run-result', ...row };
  }
}

function short(id) {
  return String(id || '').slice(0, 8);
}
