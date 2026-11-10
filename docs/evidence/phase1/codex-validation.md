# Codex CLI 混合验证（T06 附带项）

日期：2026-11-10 · 状态：进行中（骨架，待实测回填）

## 一、环境与已知事实

| 项 | 值 |
| --- | --- |
| Codex CLI 版本 | 0.167.0（npm 全局安装） |
| hooks 特性 | `codex features list` 确认 `hooks: stable, true`（默认启用；`plugin_hooks` 已移除） |
| 配置覆盖通道 | `codex exec -c <key=value>`（dotted path，value 按 TOML 解析；不改动 `~/.codex/config.toml`） |
| 用户已有配置 | `~/.codex/config.toml` 的 `notify` 指向 computer-use 脚本——**该槽被占用，不覆盖**；hooks 为独立叠加通道，互不影响 |
| DSH | 本轮仅预留接入点：`src/host/lib/adapters.mjs` 的 `dshAdapter` 返回 null |

## 二、Hooks 配置面（官方文档 developers.openai.com/codex/hooks 核实，2026-11-10）

- **事件**：`SessionStart` `PreToolUse` `PermissionRequest` `PostToolUse` `PreCompact` `PostCompact` `UserPromptSubmit` `SubagentStart` `SubagentStop` `Stop`。无 `SessionEnd` / `Notification` / `StopFailure` / `PermissionDenied`。
- **发现位置**：`~/.codex/hooks.json`、`~/.codex/config.toml` 内联 `[hooks]`、`<repo>/.codex/hooks.json`、`<repo>/.codex/config.toml`；多层并存全部生效。**项目层需项目被 trust 才加载**。
- **信任模型**：非 managed hook 须先经 `/hooks` 审阅并 trust（按 hook 哈希记录）；`--dangerously-bypass-hook-trust` 可单次跳过（一次性自动化已自证来源的场景）。
- **输入**：stdin 一个 JSON——`session_id` `transcript_path` `cwd` `hook_event_name` `model` + 事件专属（`turn_id` `tool_name` `tool_use_id` `tool_input` 等）。字段名与 Claude Code hook 基本同构。
- **PermissionRequest 可代答**：hook 输出 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` 可 allow/deny，等价审批 UI——这是 Codex 侧复刻「等待→人工/脚本处理→解除」闭环的通道。
- **同步执行**：`async:true` 被解析但**跳过不跑**；`command_windows` 可覆盖 Windows 命令；`matcher` 按工具名过滤（省略=全部）。
- **`codex exec` 非交互**：权限默认不可交互审批，PermissionRequest hook 代答是拿到「等待」信号并延续流程的关键。

## 三、适配器现状与修正计划

事件名与 Claude Code 同构，`codexAdapter` 修正映射：`SessionStart→started`、`UserPromptSubmit→prompt`、`PreToolUse→tool-start`、`PermissionRequest→permission(→waiting)`、`PostToolUse→tool-end`、`Stop→turn-end`；无对应事件的语义（会话退出、API 失败、用户拒绝）走 unknown / 超时过期兜底并记录缺口。`turn-complete` 旧映射废弃。

`codexAdapter`（adapters.mjs）：`turn-complete → turn-end`，其余事件映射 `unknown`。即 Codex 会话在统一状态机里可入队显示为 unknown（可跳转、不可自动解除），除非 hooks/notify 能提供可靠信号。

## 三、验证计划

1. 探明 hooks 配置面：`codex features list`、`codex exec --help` 全文、官方文档（网络恢复后）。
2. 若 hooks 可用：`-c` 注入临时 hook 配置（无侵入、可还原），采集 Codex 会话事件 → 补充 codexAdapter 映射。
3. 混合场景：同一扩展管理的两个终端，一个 `claude` 一个 `codex`，各自产生待办 → 验证入队、显示、快捷键分别跳对、处理后状态更新或按缺口规则显示 unknown。
4. 拿不到的状态：显示 unknown 并在本文件记录版本、复现步骤与缺口。

## 四、实测结果

<!-- 待回填：逐次记录、跳转准确性统计、缺口清单 -->
