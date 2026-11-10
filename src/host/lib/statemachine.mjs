/**
 * Unified session state machine + todo queue (S0).
 *
 * Pure logic, no I/O. Input: unified events produced by agent adapters
 * (claude-code, codex, ...). Output: session states, the todo queue and
 * versioned screen snapshots. Queue, screen and focus flow only see
 * unified states — agent specifics stay in adapters.
 *
 * States: running | waiting | failed | completed | unknown | offline
 *
 * Evidence rules (PRD §4):
 *  - waiting raised by PermissionRequest (real-time); Notification with
 *    type permission_prompt is supplementary (~6s late) and deduped.
 *  - PreToolUse alone never means waiting.
 *  - waiting cleared ONLY by progress evidence postdating the prompt:
 *    the awaited tool's completion, a tool call that did not exist before
 *    the prompt, a new prompt, turn end/failure, or offline. A tool that
 *    was already running before the prompt never clears it.
 *  - PermissionDenied (auto mode) is recorded as evidence only.
 *  - waiting entries idle beyond expireMs become expired → big key refuses.
 *
 * Snapshot versioning: `v` increments only when the card CONTENT changes
 * (current card identity/state or queue depth), so a big-key press can
 * compare its captured `v` against the live one to refuse stale jumps.
 */

export const UNIFIED_STATES = ['running', 'waiting', 'failed', 'completed', 'unknown', 'offline'];

const EXPIRE_MS_DEFAULT = 10 * 60 * 1000;

export const STATE_ZH = {
  running: '运行中',
  waiting: '等待权限',
  failed: '出错待看',
  completed: '已完成',
  unknown: '未知',
  offline: '已离线',
};

export class StateMachine {
  /**
   * @param {{expireMs?: number, keyLabel?: string,
   *          onSnapshot?: (snap: object) => void,
   *          onTransition?: (tr: object) => void}} opts
   */
  constructor(opts = {}) {
    this.expireMs = opts.expireMs ?? EXPIRE_MS_DEFAULT;
    this.keyLabel = opts.keyLabel || 'Ctrl+Alt+V';
    this.onSnapshot = opts.onSnapshot || (() => {});
    this.onTransition = opts.onTransition || (() => {});
    /** @type {Map<string, object>} key: binding */
    this.sessions = new Map();
    /** @type {string[]} bindings currently queued (waiting/failed) */
    this.queue = [];
    this.version = 0;
    this._sig = '';
  }

  // ------------------------------------------------------------- public API

  apply(ev) {
    const key = ev.binding;
    if (!key) return;
    let s = this.sessions.get(key);
    if (!s) {
      s = newSession(key, ev);
      this.sessions.set(key, s);
    }
    s.lastEventTs = ev.ts;
    s.lastEvent = ev.kind;

    const before = describe(s);
    transition(s, ev);
    const after = describe(s);

    if (before !== after) {
      this.onTransition({ binding: key, from: before, to: after, ev: ev.kind, ts: ev.ts });
      this.touchQueue(s);
    }
    this.refresh();
  }

  removeBinding(binding) {
    if (!this.sessions.has(binding)) return;
    this.sessions.delete(binding);
    const idx = this.queue.indexOf(binding);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.refresh();
  }

  /** Snapshot WITHOUT consuming: same content ⇒ same v. */
  snapshot() {
    const live = this.liveQueue();
    const cur = live[0] || null;
    return {
      v: this.version,
      current: cur ? this.cardFor(cur, live) : null,
      queue: live.length,
      keyLabel: this.keyLabel,
      generatedAt: Date.now(),
    };
  }

  /** Operable big-key target or {ok:false, reason}. */
  currentTarget(now = Date.now()) {
    const live = this.liveQueue();
    const cur = live[0];
    if (!cur) return { ok: false, reason: 'empty', v: this.version };
    if (cur.state === 'waiting' && now - cur.lastEventTs > this.expireMs) {
      return { ok: false, reason: 'expired', binding: cur.binding, v: this.version };
    }
    return {
      ok: true, binding: cur.binding, short: cur.short, state: cur.state,
      since: cur.waitingSince, queueDepth: live.length, v: this.version,
    };
  }

  /** Set the label of the big key (display only). */
  setKeyLabel(label) { this.keyLabel = label; this.refresh(); }

  // -------------------------------------------------------------- internals

  liveQueue() {
    return this.queue
      .map((k) => this.sessions.get(k))
      .filter((s) => s && (s.state === 'waiting' || s.state === 'failed'))
      .sort((a, b) => a.waitingSince - b.waitingSince);
  }

  cardFor(s, live) {
    return {
      short: s.short,
      state: STATE_ZH[s.state] || s.state,
      stateKey: s.state,
      expired: s.state === 'waiting' && Date.now() - s.lastEventTs > this.expireMs,
      since: s.waitingSince,
      pos: live.indexOf(s) + 1,
      total: live.length,
      binding: s.binding,
      agent: s.agent,
    };
  }

  touchQueue(s) {
    const wants = s.state === 'waiting' || s.state === 'failed';
    const idx = this.queue.indexOf(s.binding);
    if (wants && idx < 0) this.queue.push(s.binding);
    if (!wants && idx >= 0) this.queue.splice(idx, 1);
  }

  /** Recompute content signature; bump version + emit snapshot on change. */
  refresh() {
    const snap = this.snapshot();
    const sig = JSON.stringify([snap.current && [snap.current.binding, snap.current.stateKey, snap.current.expired, snap.current.total, snap.current.since], snap.queue]);
    if (sig !== this._sig) {
      this._sig = sig;
      this.version += 1;
      snap.v = this.version;
      this.onSnapshot({ ...snap, current: snap.current ? { ...snap.current } : null });
    }
  }
}

function newSession(binding, ev) {
  return {
    binding,
    short: ev.short || binding,
    agent: ev.agent || 'claude-code',
    session: ev.session || '',
    state: 'unknown',
    waitingSince: 0,
    notifyOnly: false,
    lastEventTs: ev.ts,
    lastEvent: '',
    /** ids of tool calls known to be in flight (PreToolUse seen, not ended) */
    inFlight: new Set(),
    /** id of the tool call the current permission prompt is about */
    awaitedToolId: '',
    evidence: [],
    failureNote: '',
  };
}

function describe(s) {
  return `${s.state}${s.waitingSince ? '@' + s.waitingSince : ''}`;
}

// ---------------------------------------------------------------- transitions

function transition(s, ev) {
  const k = ev.kind;
  switch (k) {
    case 'started':
      s.state = 'running';
      break;

    case 'prompt':
      if (s.state === 'waiting') clearWaiting(s, 'new-prompt');
      s.state = 'running';
      break;

    case 'tool-start': {
      const id = ev.toolUseId || '';
      if (id) {
        if (s.state === 'waiting' && id !== s.awaitedToolId && !s.inFlight.has(id)) {
          // a tool call that did not exist before the prompt ⇒ prompt resolved
          clearWaiting(s, 'new-tool');
        }
        s.inFlight.add(id);
      }
      if (['unknown', 'offline', 'completed'].includes(s.state)) s.state = 'running';
      break;
    }

    case 'permission':
      s.awaitedToolId = lastInFlight(s);
      s.state = 'waiting';
      s.waitingSince = ev.ts;
      s.notifyOnly = false;
      note(s, `perm:${ev.tool || 'tool'}`);
      break;

    case 'permission-notify':
      if (s.state !== 'waiting') {
        s.state = 'waiting';
        s.waitingSince = ev.ts;
        s.notifyOnly = true;
        note(s, 'perm-notify');
      }
      break;

    case 'tool-end':
    case 'tool-fail': {
      const id = ev.toolUseId || '';
      if (id) {
        if (s.state === 'waiting' && (id === s.awaitedToolId || !s.inFlight.has(id))) {
          clearWaiting(s, k === 'tool-end' ? 'tool-done' : 'tool-failed');
        }
        s.inFlight.delete(id);
        if (id === s.awaitedToolId) s.awaitedToolId = '';
      }
      if (k === 'tool-fail') s.failureNote = ev.note || 'tool failed';
      if (['unknown', 'offline'].includes(s.state)) s.state = 'running';
      break;
    }

    case 'denied-auto':
      note(s, 'denied-auto');
      break;

    case 'turn-end':
      if (s.state === 'waiting') clearWaiting(s, 'turn-end');
      s.state = 'completed';
      break;

    case 'turn-failed':
      if (s.state === 'waiting') clearWaiting(s, 'turn-failed');
      s.state = 'failed';
      s.failureNote = ev.note || 'turn failed';
      break;

    case 'session-end':
      s.state = 'offline';
      break;

    default:
      note(s, k);
      if (s.state === 'offline') s.state = 'unknown';
      break;
  }
}

function lastInFlight(s) {
  // the awaited tool is the most recent in-flight call (PreToolUse directly
  // precedes the matching PermissionRequest in the observed stream)
  let last = '';
  for (const id of s.inFlight) last = id; // Set preserves insertion order
  return last;
}

function clearWaiting(s, evidence) {
  s.waitingSince = 0;
  s.notifyOnly = false;
  s.awaitedToolId = '';
  s.state = 'running'; // callers override with terminal states as needed
  note(s, `cleared:${evidence}`);
}

function note(s, text) {
  s.evidence.push(text);
  if (s.evidence.length > 32) s.evidence.shift();
}
