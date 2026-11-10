# T03 Hook 事件采集与状态转换表（Claude Code 2.1.286 实测）

日期：2026-11-10 · 采集方式：`tests/capture-samples.mjs` 驱动真实 `claude -p` 会话（受控沙箱 `tests/fixtures/sandbox-{A,B}`，Hook 配置经 `--settings <临时文件>` 注入，**不改动用户任何配置文件**；权限应答走官方 `--permission-prompt-tool mcp__vibeperm__permission_prompt` 通道；`--permission-mode manual` 强制每次工具调用必问）

实测踩坑（均已固化进采集脚本）：

1. **`-p` 默认 auto 权限模式不询问**：auto 分类器把 `echo` / `node -e` 判为低风险直接放行，`PermissionRequest` 根本不触发。必须 `--permission-mode manual`（另加 `permissions.ask` 双保险，因 `--settings` 层叠在用户全局配置之上、不隔离）。
2. **settings `env` 块不注入 Hook 子进程**（实测 binding/pipe 均空）→ 路由改 forwarder 命令行参数 `--binding`。
3. **`async: true` Hook 在短命 `-p` 会话几乎全丢**（进程退出杀子进程，10 个事件仅偶然存活 1 个）→ 全部改同步 Hook（每事件阻塞 ~60ms，forwarder 自限 1.2s 兜底）。

## 一、事件 → 统一状态转换表（实现：`src/host/lib/adapters.mjs` + `statemachine.mjs`）

| Claude Code 事件 | 统一事件 | 状态效果 | 说明 |
| --- | --- | --- | --- |
| `SessionStart` | started | → running | 会话开始/恢复 |
| `UserPromptSubmit` | prompt | → running；waiting 清除（证据 `new-prompt`） | 用户提交了新工作 |
| `PreToolUse` | tool-start | 不改变 waiting | 单独出现**不代表**正在等用户；新 toolUseId 可清除 waiting（证据 `new-tool`） |
| `PermissionRequest` | permission | → **waiting**（实时信号，入队） | 记录 awaitedToolId=最近 in-flight 调用 |
| `Notification(permission_prompt)` | permission-notify | → waiting（仅当未处于 waiting；去重） | 约 6s 延迟，**只作补充**，单独计量 |
| `Notification(idle_prompt)` 等其他 | —（丢弃） | 无 | 空闲提醒不是待办 |
| `PostToolUse` | tool-end | waiting 清除仅当：id==awaitedToolId 或 id 为提示之后新出现的调用 | **提示前已在跑的无关工具完成不清除**（防误清） |
| `PostToolUseFailure` | tool-fail | 同上清除规则；记 failureNote | 工具失败证据 |
| `PermissionDenied` | denied-auto | 仅记录证据，**不改状态** | 官方仅覆盖 auto mode 拒绝，不当作"用户点了拒绝" |
| `Stop` | turn-end | waiting 清除；→ completed | 回合完成 |
| `StopFailure` | turn-failed | waiting 清除；→ failed（仍可跳转） | API 错误（rate_limit 等） |
| `SessionEnd` | session-end | → offline，出队 | 会话退出 |

队列规则：按 `waitingSince`（首次等待时间）排序、按 binding 去重；`failed` 条目同样可跳转（用户应查看）；waiting 超过 10 分钟无事件 → 过期（大键拒绝，提示刷新）。

## 二、解除证据（实测观察）

| 场景 | 观察到的解除路径（真实样本实证） |
| --- | --- |
| 允许（allow） | `PostToolUse(awaited id)` → `Stop`（A-allow / B-allow 实测序列） |
| 拒绝（deny，权限面板选 No） | **实测**：无 awaited 工具的 `PostToolUse`，由 `Stop` 清除（A-deny 序列：`PermissionRequest` 后直接 `Stop`，工具未执行） |
| 取消（Esc） | `-p` 无 TUI，无法按 Esc——**待人工 TUI 样本补充**，预期同 deny 路径（后续事件清除） |
| 工具失败 | `PostToolUseFailure(awaited id)` → `Stop`（A-fail 实测） |
| 会话退出 | `SessionEnd`（五场景均观测） |

## 三、真实样本与覆盖统计

脱敏样本：`tests/fixtures/hooks-real-samples.jsonl`（31 事件，2026-11-10 第三轮采集，五场景全 exit=0；由 `tests/sanitize-samples.mjs` 生成，session/toolUseId 已掩码，binding 为脚本生成的随机短 ID，无提示词/工具入参/绝对路径）。

五场景实测序列（`>` 按到达顺序）：

| 场景 | 序列 |
| --- | --- |
| A-allow | SessionStart > UserPromptSubmit > PreToolUse > **PermissionRequest** > PostToolUse > Stop > SessionEnd |
| A-deny | SessionStart > UserPromptSubmit > PreToolUse > **PermissionRequest** > Stop > SessionEnd（deny：无工具执行） |
| A-fail | SessionStart > UserPromptSubmit > PreToolUse > **PermissionRequest** > PostToolUseFailure > Stop > SessionEnd |
| A-plain | SessionStart > UserPromptSubmit > Stop > SessionEnd（无工具调用） |
| B-allow | 同 A-allow（第二工作区，双会话/双项目验证） |

事件覆盖计数（31 事件）：`PermissionRequest` 4、`PreToolUse` 4、`PostToolUse` 2、`PostToolUseFailure` 1、`SessionStart` 5、`UserPromptSubmit` 5、`Stop` 5、`SessionEnd` 5。`Notification` 与 `PermissionDenied` 为 0（见第五节边界）。同名项目/终端场景由重放测试（双会话排序用例）与 G0 duplicate-name 场景覆盖。

## 四、传输时延（转发器）

实测 `fwdMs`（forwarder 内部计时：进程启动 → 写入管道完成）：**min 2 / 中位 3 / p95 25 / max 25 ms**（31 事件，本机命名管道），远低于 1.2s 自限预算；宿主不可达时静默 exit 0（已验证）。

## 五、已知边界与缺口

1. **Esc 取消**：`-p` 模式无 TUI，未采样；TUI 人工样本待用户补充（预期状态转换与 deny 同路径，由后续事件解除）。
2. **TUI 手动拒绝**：官方无"用户点了拒绝"Hook（`PermissionDenied` 仅 auto mode）；本文按证据规则处理——不区分"拒绝/取消"，仅记录"已解除"。
3. **`Notification(permission_prompt)` 在 `-p` 模式未观测**（0 样本）：MCP 应答挂起 25s（>6s 理论延迟）期间无该事件——属 TUI 空闲提醒行为，无 UI 不触发。转换表保留映射供 TUI 场景；实时等待判定只依赖 `PermissionRequest`。
4. **`PermissionDenied` 0 样本**：官方仅 auto mode 触发，manual 模式无此事件；按转换表规则仅记录证据、不改状态，不当作用户拒绝。
5. 并行工具批内无关工具完成不清除待办（重放测试覆盖：`无关工具完成不清除待办` 用例）。
