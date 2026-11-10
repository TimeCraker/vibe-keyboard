/**
 * Simulated square screen (S0): renders the current card on the host console
 * and appends every emitted snapshot to a JSONL evidence file.
 *
 * The card mirrors what the ST7789 240×240 will show: project short name,
 * fixed-zh state word, queue position/depth, big-key label. Render is a
 * plain box redraw — bounded output, no animation (首件静态状态卡基线).
 */
import { createWriteStream } from 'node:fs';
import path from 'node:path';

export class SimScreen {
  /**
   * @param {{jsonlPath?: string, width?: number, render?: boolean}} opts
   */
  constructor(opts = {}) {
    this.w = opts.width ?? 34;
    this.render = opts.render !== false;
    this.stream = opts.jsonlPath ? createWriteStream(opts.jsonlPath, { flags: 'a' }) : null;
    this.lastLine = '';
  }

  /** Update with a snapshot (same object emitted by StateMachine.onSnapshot). */
  update(snap) {
    if (this.stream) {
      this.stream.write(JSON.stringify({ ...snap, ts: Date.now() }) + '\n');
    }
    if (!this.render || !process.stdout.isTTY) {
      // Still keep the last card available for `status` queries when the host
      // runs in the background during automated acceptance.
      this.lastLine = oneLine(snap);
      return;
    }
    drawCard(snap, this.w);
    this.lastLine = oneLine(snap);
  }

  close() {
    try { this.stream?.end(); } catch { /* ignore */ }
  }
}

function oneLine(snap) {
  const c = snap.current;
  if (!c) return `[vibe] 队列空闲 · v${snap.v}`;
  return `[vibe] #${c.pos}/${c.total} ${c.short} ${c.state}${c.expired ? '(已过期)' : ''} · v${snap.v}`;
}

function drawCard(snap, w) {
  const lines = [];
  const inner = w - 2;
  const pad = (t) => ' '.repeat(Math.max(0, Math.floor((inner - wLen(t)) / 2))) + t;
  lines.push('┌' + '─'.repeat(inner) + '┐');
  const c = snap.current;
  if (!c) {
    lines.push('│' + pad('待办队列为空') + spaces(inner, pad('待办队列为空')) + '│');
    lines.push('│' + pad(snap.keyLabel + ' 大键待命') + '│');
  } else {
    const l1 = `${c.short}`;
    const l2 = `${c.state}${c.expired ? ' · 已过期' : ''}`;
    const l3 = `队列 ${c.pos}/${c.total} · ${c.agent}`;
    const l4 = `大键 ${snap.keyLabel} → 回到该会话`;
    for (const t of [l1, l2, l3, l4]) {
      lines.push('│' + pad(t) + spaces(inner, pad(t)) + '│');
    }
  }
  lines.push('└' + '─'.repeat(inner) + '┘');
  process.stdout.write('\x1b[2J\x1b[H'); // clear + home (bounded, static card)
  process.stdout.write(lines.join('\n') + '\n');
}

// display width: CJK chars are double-width in the console
function wLen(t) {
  let n = 0;
  for (const ch of t) n += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return n;
}

function spaces(inner, padded) {
  return ' '.repeat(Math.max(0, inner - wLen(padded)));
}
