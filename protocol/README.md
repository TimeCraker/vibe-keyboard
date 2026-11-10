# Vibe Keyboard 协议契约（S0 内部 IPC v0）

状态：S0 软件验证基线。设备侧协议（`HELLO` / `STATE_SNAPSHOT` / `STATE_APPLIED` / `INPUT_EVENT` / `ACTION_RESULT` / `HEARTBEAT`）在一期 T08 冻结，本文件只定义 S0 软件链路内部使用的命名管道消息，语义与设备协议对齐，便于后续替换传输层。

## 传输

- 命名管道：`\\.\pipe\vibe-keyboard-hub`（当前用户 ACL，S0 由上位机进程创建）。
- 编码：UTF-8 NDJSON，一行一条消息，单条消息上限 64 KB（有界 IPC）。
- 角色与连接形态：
  - `hook-forwarder`：独立短连接，只允许发 `hook`，不可请求聚焦；2.5s 内自行退出。
  - `extension`：每窗口实例一条长连接，登记后接收 `focus-request` / `test-control`。
  - `runner` / 调试客户端：长连接，可发 `bigkey` / `status` / `test-control`，接收 `snapshot` 与 `run-result`。

## 消息

### 上行（→ 上位机）

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `hook` | `src, binding, session, event, tool, toolUseId, notifyType, stopReason, errorKind, cwdName, ts, fwdMs` | Hook 转发器限时上报的脱敏事件。`event` 取 Agent 原生 Hook 事件名：`src:"claude-code"` 为 Claude Code Hook；`src:"codex"` 为 Codex CLI hooks.json（事件名与 Claude Code 同构，缺 SessionEnd/StopFailure 等，见 docs/evidence/phase1/codex-validation.md） |
| `hello` | `role, windowId, vscode, pid` | 扩展窗口实例登记；`role:"extension"` |
| `window-bound` | `windowId, hwnd, focused, processName` | 扩展绑定命令在前台采集的 HWND 与校验结果 |
| `terminal` | `windowId, binding, name, action:"add"\|"remove"` | 扩展管理的终端绑定上报 |
| `focus-receipt` | `reqId, binding, shown, terminalName, activeTerminal, err` | 聚焦请求回执；`activeTerminal` 为扩展实际选中的终端 |
| `mcp-waiting` / `mcp-resolved` | `binding, session` | 权限应答通道状态（仅测试驱动使用） |
| `bigkey` | `src:"pipe"\|"console"\|"hotkey", runId` | 大键触发（自动化或真实热键同一处理路径） |
| `status` | — | 请求一次 `snapshot` |

### 下行（← 上位机）

| `t` | 字段 | 说明 |
| --- | --- | --- |
| `ack` | `echoT` | 短连接回执（转发器收到的首条下行即视为 ack） |
| `snapshot` | `v, current, queue, generatedAt` | 完整状态快照；`v` 单调递增，`current` 为当前待办卡片或 `null` |
| `focus-request` | `reqId, binding, snapshotV` | 要求扩展选中并显示绑定终端；`snapshotV` 供回跳版本核对 |
| `run-result` | `runId, outcome, timings` | 单次回跳验收结果（自动成功 / 激活受限 / 失败） |
| `test-control` | `action, ...` | 仅 `VIBE_AUTOTEST` 模式：`start-session` / `dispose-terminal` 等 |

## 快照（模拟方屏 / 未来设备共用）

```json
{
  "v": 7,
  "current": {
    "short": "sandbox-A",       // 项目短名（受字库约束）
    "state": "等待权限",          // 固定中文状态词
    "stateKey": "waiting",
    "since": 1762700000000,
    "pos": 1,
    "total": 2
  },
  "queue": 2,
  "keyLabel": "Ctrl+Alt+V"
}
```

## 版本与去重

- 快照 `v` 只随完整卡片变化递增；大键触发携带触发时的 `v`，上位机在执行聚焦前核对仍为当前版本，否则提示刷新、不切换（防过期错切）。
- 重放防护：`focus-request` 的 `reqId` 一次性；扩展仅回执一次，重复 `reqId` 忽略（跨重连不重放）。
