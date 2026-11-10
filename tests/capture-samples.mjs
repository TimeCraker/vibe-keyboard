#!/usr/bin/env node
/**
 * T03 sample capture driver.
 *
 * Runs REAL `claude -p` sessions in sandbox workspaces with:
 *   - hooks injected via `--settings` (a temporary generated settings file,
 *     never touching user config; reversible by deleting the temp file)
 *   - routing via forwarder argv (--binding): settings "env" blocks are NOT
 *     inherited by hook subprocesses (observed 2.1.286)
 *   - our MCP permission server as the official permission host, deciding
 *     allow/deny per scenario
 *
 * Scenario matrix per sandbox:
 *   allow   — prompt → allow → tool runs → Stop → SessionEnd   (等待+允许+完成)
 *   deny    — prompt → deny → turn ends                        (等待+拒绝)
 *   fail    — prompt → allow a command that exits non-zero     (工具失败)
 *   plain   — no-permission task (echo via allowed pattern is not used;
 *             we ask a text-only reply)                        (无等待直接完成)
 *
 * Raw events land in docs/evidence/phase1/raw-hook-events.jsonl (gitignored
 * raw variants); sanitized fixtures are written by sanitize-samples.mjs.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const FWD = path.join(ROOT, 'src/hook-forwarder/forward.mjs');
const MCP = path.join(ROOT, 'tests/mcp-permission-server.mjs');
const RAW = path.join(ROOT, 'docs/evidence/phase1/raw-hook-events.jsonl');
mkdirSync(path.dirname(RAW), { recursive: true });

function hooksSettings(binding) {
  // Absolute forwarder path, forward slashes work in Git Bash hook shell.
  // Sync hooks + argv routing. Observed on 2.1.286: settings "env" blocks are
  // NOT inherited by hook subprocesses, and async hooks get killed when
  // short-lived -p sessions exit (0-1 of ~10 events delivered). Sync costs
  // ~60ms/event (node startup + local pipe ack); forwarder self-limits at
  // 1.2s so blocking stays bounded.
  const fwdNix = FWD.replace(/\\/g, '/');
  const hook = `node ${fwdNix} --binding ${binding}`;
  const mk = (ev) => [{ hooks: [{ type: 'command', command: hook, timeout: 10 }] }];
  return {
    // Double safety: ask rules force a prompt even if some layer allows
    // these commands. The real fix is --permission-mode manual in the
    // command line: -p defaults to auto mode whose classifier auto-allows
    // low-risk commands (observed: echo/node -e ran with no prompt at all).
    permissions: { ask: ['Bash(echo vibe-ok)', 'Bash(node -e*)'] },
    hooks: {
      SessionStart: mk(),
      UserPromptSubmit: mk(),
      PreToolUse: mk(),
      PermissionRequest: mk(),
      PostToolUse: mk(),
      PostToolUseFailure: mk(),
      PermissionDenied: mk(),
      Stop: mk(),
      StopFailure: mk(),
      Notification: mk(),
      SessionEnd: mk(),
    },
  };
}

function mcpConfig(binding, defaultBehavior) {
  return {
    mcpServers: {
      vibeperm: {
        command: 'node',
        args: [MCP.replace(/\\/g, '/'), '--binding', binding, '--default', defaultBehavior, '--wait-ms', '25000'],
      },
    },
  };
}

function tmpSettings(name, obj) {
  const p = path.join(os.tmpdir(), `vibe-${name}-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function runClaude(scenario) {
  return new Promise((resolve) => {
    const binding = `cap${Math.random().toString(16).slice(2, 8)}`;
    const settings = tmpSettings(`settings-${scenario.name}`, hooksSettings(binding));
    const mcp = tmpSettings(`mcp-${scenario.name}`, mcpConfig(binding, scenario.deny ? 'deny' : 'allow'));
    const cwd = path.join(ROOT, 'tests/fixtures', scenario.sandbox);

    const prompt = scenario.prompt;
    // Prompt goes via stdin (no quotes); every path used here is guaranteed
    // space-free (repo + os.tmpdir()), so the cmdline needs NO embedded
    // quotes — node would otherwise escape them and cmd would pass literal
    // backslash-quotes to claude (observed: "Settings file not found").
    const promptFile = settings.replace(/.json$/, '-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    const cmdline = [
      'claude', '-p', '--settings', settings, '--mcp-config', mcp,
      '--permission-mode', 'manual',
      '--permission-prompt-tool', 'mcp__vibeperm__permission_prompt',
      '<', promptFile,
    ].join(' ');
    const cp = spawn(
      process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', cmdline],
      { cwd, env: { ...process.env, VIBE_BINDING_ID: binding, VIBE_PIPE: '\\\\.\\pipe\\vibe-keyboard-hub' }, windowsHide: true },
    );
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { out += d; });
    cp.on('error', (e) => resolve({ scenario: scenario.name, binding, ok: false, err: String(e), out }));
    cp.on('close', (code) => resolve({ scenario: scenario.name, binding, ok: code === 0, code, out: out.slice(-2000) }));
  });
}

const PROMPT_PERMISSION = '请用 Bash 工具执行命令 `echo vibe-ok`，除此之外什么都不要做，不要读文件、不要重试。完成后立即结束回复。';
const PROMPT_FAIL = '请用 Bash 工具执行命令 `node -e "process.exit(7)"`，命令会失败，这是预期的。失败后不要重试也不要修复，直接结束回复。';
const PROMPT_PLAIN = '不要使用任何工具。直接回复"ok"两个字，不要做任何其他事情。';

const scenarios = [
  { name: 'A-allow', sandbox: 'sandbox-A', prompt: PROMPT_PERMISSION, deny: false },
  { name: 'A-deny', sandbox: 'sandbox-A', prompt: PROMPT_PERMISSION, deny: true },
  { name: 'A-fail', sandbox: 'sandbox-A', prompt: PROMPT_FAIL, deny: false },
  { name: 'A-plain', sandbox: 'sandbox-A', prompt: PROMPT_PLAIN, deny: false },
  { name: 'B-allow', sandbox: 'sandbox-B', prompt: PROMPT_PERMISSION, deny: false },
];

const results = [];
for (const sc of scenarios) {
  process.stdout.write(`[${sc.name}] running real claude session...\n`);
  const r = await runClaude(sc);
  results.push(r);
  process.stdout.write(`[${sc.name}] exit=${r.code ?? r.err} \n`);
}

// Marker file so the sanitizer knows which bindings were ours.
const marker = path.join(os.tmpdir(), `vibe-capture-bindings-${Date.now()}.json`);
writeFileSync(marker, JSON.stringify(results.map((r) => r.binding)));
writeFileSync(RAW, JSON.stringify({ capturedAt: new Date().toISOString(), marker, results }, null, 2));
console.log('done. results ->', RAW);
console.log('bindings marker ->', marker);
