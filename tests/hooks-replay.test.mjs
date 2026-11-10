/**
 * S0 state-machine replay tests (node --test).
 *
 * Two layers:
 *  1. Direct unit tests against the pure StateMachine + adapter.
 *  2. Integration: `node host.mjs replay fixtures/hooks-replay.jsonl` and
 *     assert the emitted transition/snapshot stream.
 *
 * Run: node --test tests/hooks-replay.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateMachine } from '../src/host/lib/statemachine.mjs';
import { claudeCodeAdapter } from '../src/host/lib/adapters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raw hook event helper (shape emitted by src/hook-forwarder/forward.mjs).
let seq = 0;
function hook(event, extra = {}) {
  seq += 1;
  return {
    t: 'hook', src: 'claude-code', binding: extra.binding || 'aaaa1111',
    session: extra.session || 'sess-1', event,
    tool: extra.tool || '', toolUseId: extra.toolUseId || '',
    notifyType: extra.notifyType || '', stopReason: '', errorKind: '',
    cwdName: extra.cwdName || 'sandbox-A', ts: extra.ts ?? 1000 + seq, fwdMs: 5,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'binding' && k !== 'session' && k !== 'cwdName')),
  };
}

function feed(sm, events) {
  for (const e of events) {
    const unified = claudeCodeAdapter(e);
    if (unified) sm.apply(unified);
  }
}

// ---------------------------------------------------------------- scenarios

test('allow flow: 等待 → 允许 → 完成 → 退出', () => {
  const trs = [];
  const sm = new StateMachine({ onTransition: (t) => trs.push(t) });
  feed(sm, [
    hook('SessionStart'),
    hook('UserPromptSubmit'),
    hook('PreToolUse', { tool: 'Bash', toolUseId: 'toolu_1' }),
    hook('PermissionRequest', { tool: 'Bash' }),
    hook('PostToolUse', { tool: 'Bash', toolUseId: 'toolu_1' }),
    hook('Stop'),
    hook('SessionEnd', { stopReason: 'other' }),
  ]);
  assert.equal(trs.at(-2).to.startsWith('completed'), true, 'ends completed');
  assert.equal(trs.at(-1).to.startsWith('offline'), true, 'then offline');
  const states = trs.map((t) => t.to.split('@')[0]);
  assert.ok(states.includes('waiting'), 'must pass through waiting');
  assert.equal(sm.currentTarget(20000).ok, false);
  assert.equal(sm.currentTarget(20000).reason, 'empty');
});

test('deny flow: 等待 → 拒绝（无工具完成）→ Stop 清除', () => {
  const trs = [];
  const sm = new StateMachine({ onTransition: (t) => trs.push(t) });
  feed(sm, [
    hook('SessionStart'),
    hook('UserPromptSubmit'),
    hook('PreToolUse', { tool: 'Bash', toolUseId: 'toolu_2' }),
    hook('PermissionRequest', { tool: 'Bash' }),
    // user denies in TUI: no PostToolUse for toolu_2; Claude sees the denial
    hook('Stop'),
  ]);
  const states = trs.map((t) => t.to.split('@')[0]);
  assert.ok(states.includes('waiting'));
  assert.ok(states.includes('completed'));
  assert.equal(sm.currentTarget(20000).reason, 'empty');
});

test('无关工具完成不清除待办；awaited 工具完成才清除', () => {
  const sm = new StateMachine({});
  feed(sm, [
    hook('SessionStart'),
    hook('UserPromptSubmit'),
    hook('PreToolUse', { tool: 'Read', toolUseId: 'toolu_a' }),
    hook('PreToolUse', { tool: 'Bash', toolUseId: 'toolu_b' }),
    hook('PermissionRequest', { tool: 'Bash' }), // awaited = toolu_b (latest)
    hook('PostToolUse', { tool: 'Read', toolUseId: 'toolu_a' }), // pre-existing tool
  ]);
  let t = sm.currentTarget(20000);
  assert.equal(t.ok, true, 'unrelated PostToolUse must NOT clear waiting');
  assert.equal(t.binding, 'aaaa1111');
  feed(sm, [hook('PostToolUse', { tool: 'Bash', toolUseId: 'toolu_b' })]);
  assert.equal(sm.currentTarget(20000).ok, false, 'awaited tool completion clears');
});

test('PermissionRequest 之后的全新工具调用可清除等待', () => {
  const sm = new StateMachine({});
  feed(sm, [
    hook('UserPromptSubmit'),
    hook('PreToolUse', { tool: 'Bash', toolUseId: 'toolu_x' }),
    hook('PermissionRequest', { tool: 'Bash' }),
    hook('PreToolUse', { tool: 'Read', toolUseId: 'toolu_new' }), // new id → resolved
  ]);
  assert.equal(sm.currentTarget(20000).ok, false);
});

test('Notification(permission_prompt) 补充信号去重，不重复入队', () => {
  const snaps = [];
  const sm = new StateMachine({ onSnapshot: (s) => snaps.push(s) });
  feed(sm, [
    hook('PermissionRequest', { tool: 'Bash' }),
    hook('Notification', { notifyType: 'permission_prompt' }),
  ]);
  const t = sm.currentTarget(20000);
  assert.equal(t.ok, true);
  assert.equal(sm.queue.length, 1, 'deduped to one queue entry');
  // alone it also raises waiting:
  const sm2 = new StateMachine({});
  feed(sm2, [hook('Notification', { notifyType: 'permission_prompt', binding: 'bbbb2222', cwdName: 'sandbox-B' })]);
  assert.equal(sm2.currentTarget(20000).ok, true);
});

test('idle_prompt 不是待办', () => {
  const sm = new StateMachine({});
  feed(sm, [hook('Notification', { notifyType: 'idle_prompt' })]);
  assert.equal(sm.currentTarget(20000).ok, false);
});

test('工具失败有记录，StopFailure → failed 仍可跳转', () => {
  const sm = new StateMachine({});
  feed(sm, [
    hook('UserPromptSubmit'),
    hook('PreToolUse', { tool: 'Bash', toolUseId: 'toolu_f' }),
    hook('PermissionRequest', { tool: 'Bash' }),
    hook('PostToolUseFailure', { tool: 'Bash', toolUseId: 'toolu_f' }),
    hook('StopFailure', { errorKind: 'rate_limit' }),
  ]);
  const t = sm.currentTarget(20000);
  assert.equal(t.ok, true, 'failed turns stay operable');
  assert.equal(t.state, 'failed');
});

test('过期条目不可操作', () => {
  const sm = new StateMachine({ expireMs: 50 });
  feed(sm, [
    hook('PermissionRequest', { tool: 'Bash', ts: Date.now() - 5000 }),
  ]);
  const t = sm.currentTarget(Date.now());
  assert.equal(t.ok, false);
  assert.equal(t.reason, 'expired');
});

test('两个会话按首次等待时间排序，队首解除后自动顶替', () => {
  const sm = new StateMachine({});
  feed(sm, [hook('PermissionRequest', { tool: 'Bash', binding: 'first1', ts: 2000 })]);
  feed(sm, [hook('PermissionRequest', { tool: 'Bash', binding: 'second', ts: 3000 })]);
  assert.equal(sm.currentTarget(20000).binding, 'first1');
  feed(sm, [hook('Stop', { binding: 'first1', ts: 4000 })]);
  assert.equal(sm.currentTarget(20000).binding, 'second');
});

test('快照版本只在内容变化时递增', () => {
  const sm = new StateMachine({});
  feed(sm, [hook('PermissionRequest', { tool: 'Bash', binding: 'ver001', ts: 1000 })]);
  const v1 = sm.snapshot().v;
  const v2 = sm.snapshot().v;
  assert.equal(v1, v2, 'no content change ⇒ same version');
  feed(sm, [hook('Stop', { binding: 'ver001', ts: 2000 })]);
  assert.ok(sm.snapshot().v > v1, 'content change ⇒ version bump');
});

// ------------------------------------------------------- host replay (CLI)

test('host.mjs replay 输出转换与终态', () => {
  const out = execFileSync('node', [
    path.join(ROOT, 'src/host/host.mjs'), 'replay',
    path.join(ROOT, 'tests/fixtures/hooks-replay.jsonl'),
  ], { encoding: 'utf8' });
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  const transitions = lines.filter((l) => l.t === 'transition');
  const final = lines.find((l) => l.t === 'final');
  const states = transitions.map((t) => t.to.split('@')[0]);
  assert.ok(states.includes('waiting'), 'fixture reaches waiting');
  assert.ok(states.includes('completed'));
  assert.equal(final.snapshot.current, null, 'queue drains at end');
});
