# Codex CLI 混合验证（T06 附带项）

日期：2026-11-10 · 状态：**自动化六阶段通过**（结果 JSON：`runs/codex-mixed-2026-11-10T12-30-49.json`）

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

## 三·五、混合验证实现（已就绪待实跑）

- `tests/run-codex-mixed.mjs`：单窗双终端（claude + codex）六阶段——claude 入队 → codex 入队 → 大键跳最早项（回执核对选对终端）→ `mcp-allow{binding}` 释放 → 大键跳第二项 → 释放 → 逐次结果 JSON 落 `docs/evidence/phase1/runs/codex-mixed-*.json`。
- `tests/codex-permission-hook.mjs`：Codex `PermissionRequest` hook——上报宿主等待、监听 `mcp-allow/deny`（**广播消息按 `binding` 字段过滤**，与 Claude MCP server 同一约定，双等待不串扰）、超时按 `--default` 决策；stdout 返回官方 `hookSpecificOutput.decision` 形状。
- Codex 终端命令：`codex exec --dangerously-bypass-hook-trust -s read-only - < prompt.txt`（stdin 传中文提示词；项目层 `.codex/hooks.json` 由 `tests/fixtures/codex-hooks-template.json` 运行时生成，sandbox-codex gitignored，跑完可删）。
- 运行前提：宿主 serve 在线 + 一个 VIBE_AUTOTEST=1 的 sandbox-A 窗（run-g0 launch 产出）+ 本机 `codex` 0.167.0。

`codexAdapter`（adapters.mjs）：`turn-complete → turn-end`，其余事件映射 `unknown`。即 Codex 会话在统一状态机里可入队显示为 unknown（可跳转、不可自动解除），除非 hooks/notify 能提供可靠信号。

## 三、验证计划

1. 探明 hooks 配置面：`codex features list`、`codex exec --help` 全文、官方文档（网络恢复后）。
2. 若 hooks 可用：`-c` 注入临时 hook 配置（无侵入、可还原），采集 Codex 会话事件 → 补充 codexAdapter 映射。
3. 混合场景：同一扩展管理的两个终端，一个 `claude` 一个 `codex`，各自产生待办 → 验证入队、显示、快捷键分别跳对、处理后状态更新或按缺口规则显示 unknown。
4. 拿不到的状态：显示 unknown 并在本文件记录版本、复现步骤与缺口。

## 四、实测结果（2026-11-10 12:30，自动化六阶段）

单窗双终端（同一 VS Code 窗口：`vibe mixc81eac (claude)` 跑 claude、`vibe mixx31fe9` 跑 codex）：

| 阶段 | 结果 | 关键数据 |
| --- | --- | --- |
| 1 claude 入队 | ✅ | waiting 卡片 v=8，MCP permission 通道上报 |
| 2 codex 入队 | ✅ | queue=2；codex PermissionRequest hook 上报（tool=Bash） |
| 3 大键跳最旧项（claude） | ✅ | 回执 716ms，activeTerminal 选中 claude 终端（核对一致）；前台激活锁屏拒绝 → activation-denied 单列 |
| 4 释放 claude | ✅ | `mcp-allow{binding}` 后 current 切到 codex |
| 5 大键跳 codex | ✅ | 回执 688ms，activeTerminal 选中 codex 终端（**分别跳对实证**）；同上 activation-denied 单列 |
| 6 释放 codex | ✅ | 队列清空 |

**实测发现**：
1. `-s read-only` 沙箱下 `echo` 免审批直跑（无 PermissionRequest）；改用写文件命令（`echo ... > proof.txt`）被沙箱拦 → 提升审批 → PermissionRequest hook 触发。等待信号依赖"需要提升权限的操作"。
2. codex hooks 项目层 + `--dangerously-bypass-hook-trust` 在 codex exec 非交互下生效（8 事件全序到达宿主，fwdMs 同级）。
3. 终端名后缀 "(claude)" 是扩展建终端时的固定标签，混合场景下 codex 终端也带此后缀（仅显示瑕疵，回执按终端对象核对不受影响）——后续按 agent 参数化。

**缺口（按规范单列）**：Codex 无 `SessionEnd`（会话退出靠 Stop+超时）、无 `StopFailure`（API 失败显示 unknown）、无 `PermissionDenied`（用户拒绝语义不可采集）——均已在适配器以 unknown/过期兜底并记录。前台激活与 G0 同受锁屏限制，解锁后与 20×2 一并实测。
