#!/usr/bin/env node
/**
 * T03 sanitizer: read the host's received-hook log (raw but already trimmed
 * by the forwarder), strip anything identifying, and write the sanitized
 * sample fixtures + a per-event coverage summary used by the T03 evidence
 * doc.
 *
 * Usage: node tests/sanitize-samples.mjs <raw-hooks.jsonl> [out.jsonl]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input) { console.error('usage: node tests/sanitize-samples.mjs <raw-hooks.jsonl> [out.jsonl]'); process.exit(2); }

const lines = readFileSync(input, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const out = [];
const cov = new Map();
for (const l of lines) {
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  if (e.t !== 'hook') continue;
  const key = e.event + (e.notifyType ? `/${e.notifyType}` : '');
  cov.set(key, (cov.get(key) || 0) + 1);
  out.push({
    t: 'hook',
    src: e.src,
    binding: e.binding, // already an opaque short id we generated
    session: mask(e.session),
    event: e.event,
    tool: e.tool || '',
    toolUseId: mask(e.toolUseId),
    notifyType: e.notifyType || '',
    stopReason: e.stopReason || '',
    errorKind: e.errorKind || '',
    cwdName: e.cwdName || '',
    ts: e.ts,
    fwdMs: e.fwdMs,
  });
}

writeFileSync(output || 'tests/fixtures/hooks-real-samples.jsonl', out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log('sanitized:', out.length, 'events →', output || 'tests/fixtures/hooks-real-samples.jsonl');
console.log('coverage:');
for (const [k, n] of [...cov.entries()].sort()) console.log(`  ${k.padEnd(38)} ${n}`);

function mask(s) {
  s = String(s || '');
  if (!s) return '';
  return s.length <= 12 ? s.slice(0, 4) + '…' : s.slice(0, 8) + '…' + s.slice(-4);
}
