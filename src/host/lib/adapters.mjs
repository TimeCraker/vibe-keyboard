/**
 * Agent adapters: raw agent-specific events → unified events for the state
 * machine. All Claude Code specifics live here; the queue, screen and focus
 * flow never import agent names beyond the `agent` label.
 */

/**
 * Claude Code hook event (as sanitized by src/hook-forwarder/forward.mjs)
 * → unified event or null (not state-relevant).
 */
export function claudeCodeAdapter(raw) {
  const base = {
    agent: 'claude-code',
    binding: raw.binding,
    session: raw.session,
    short: raw.cwdName || raw.binding,
    ts: raw.ts || Date.now(),
    toolUseId: raw.toolUseId || '',
    tool: raw.tool || '',
    note: '',
  };
  switch (raw.event) {
    case 'SessionStart': return { ...base, kind: 'started' };
    case 'UserPromptSubmit': return { ...base, kind: 'prompt' };
    case 'PreToolUse': return { ...base, kind: 'tool-start' };
    case 'PermissionRequest': return { ...base, kind: 'permission' };
    case 'Notification':
      if (raw.notifyType === 'permission_prompt') return { ...base, kind: 'permission-notify' };
      return null; // idle_prompt etc. are not todos
    case 'PostToolUse': return { ...base, kind: 'tool-end' };
    case 'PostToolUseFailure': return { ...base, kind: 'tool-fail', note: 'tool failed' };
    case 'PermissionDenied': return { ...base, kind: 'denied-auto' };
    case 'Stop': return { ...base, kind: 'turn-end' };
    case 'StopFailure': return { ...base, kind: 'turn-failed', note: raw.errorKind || 'stop failure' };
    case 'SessionEnd': return { ...base, kind: 'session-end' };
    default: return { ...base, kind: 'unknown-signal' };
  }
}

/**
 * Codex CLI hook event → unified event.
 *
 * Verified against the official Codex hooks docs (developers.openai.com/
 * codex/hooks, CLI 0.167.0): hooks.json / config.toml [hooks] layers, stdin
 * payload with the same field names as Claude Code (session_id,
 * hook_event_name, tool_name, tool_use_id...). Events that Claude Code has
 * but Codex lacks: SessionEnd, StopFailure, PostToolUseFailure,
 * PermissionDenied, Notification — session exit and API failures therefore
 * degrade to unknown plus waiting-timeout expiry (documented gap, see
 * docs/evidence/phase1/codex-validation.md).
 */
export function codexAdapter(raw) {
  const base = {
    agent: 'codex',
    binding: raw.binding,
    session: raw.session || '',
    short: raw.cwdName || raw.binding,
    ts: raw.ts || Date.now(),
    toolUseId: raw.toolUseId || '',
    tool: raw.tool || '',
    note: '',
  };
  switch (raw.event) {
    case 'SessionStart': return { ...base, kind: 'started' };
    case 'UserPromptSubmit': return { ...base, kind: 'prompt' };
    case 'PreToolUse': return { ...base, kind: 'tool-start' };
    case 'PermissionRequest': return { ...base, kind: 'permission' };
    case 'PostToolUse': return { ...base, kind: 'tool-end' };
    case 'Stop': return { ...base, kind: 'turn-end' };
    default: return { ...base, kind: 'unknown-signal' };
  }
}

/**
 * DSH adapter placeholder — reserved integration point, not implemented in
 * S0. Whatever DSH exposes later converts to the same unified events.
 */
export function dshAdapter(_raw) {
  return null;
}
