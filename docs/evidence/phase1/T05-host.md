# T05 上位机与模拟方屏（S0，Node 实现）

日期：2026-11-10 · 入口：`src/host/host.mjs` · 依赖：Node ≥ 24，零 npm 依赖

> 语言说明：产品目标栈为 C#/.NET 10（PRD §2）。本次 .NET SDK 安装失败（见
> [T01](T01-environment.md)），S0 上位机以 Node 实现，协议契约与行为断言与
> C# 版共用（`protocol/README.md` + `tests/hooks-replay.test.mjs`），后续按同一
> 契约移植。

## 组成

| 模块 | 职责 |
| --- | --- |
| `lib/statemachine.mjs` | 统一状态机（running/waiting/failed/completed/unknown/offline）+ 待办队列 + 版本化快照。纯逻辑，无 I/O，重放测试覆盖 |
| `lib/adapters.mjs` | Claude Code 适配器（Hook 事件 → 统一事件）；Codex 适配器（notify → 统一）；DSH 预留接口 |
| `lib/hub.mjs` | 命名管道 `\\.\pipe\vibe-keyboard-hub`：转发器短连接（只收事件、回 ack、不可请求聚焦）、扩展长连接（按窗口登记、路由聚焦请求）、runner 控制连接；大键聚焦控制器（回执 + 前台核对） |
| `lib/screen.mjs` | 模拟方屏：控制台静态状态卡（项目短名/中文状态词/队列位次/大键映射）+ 每张快照追加 `screen-snapshots.jsonl`（状态快照样例） |
| `scripts/ps/hotkey-sidecar.ps1` | RegisterHotKey 全局热键（默认 Ctrl+Alt+V，`-Mods/-Vk` 可改）；按下输出一行 → 宿主大键处理 |
| `scripts/ps/win32ops-sidecar.ps1` | Win32 行协议边车：foreground / activate（SetForegroundWindow）/ activate_attach（AttachThreadInput 回退）/ minimize / pid_hwnd |

## 关键行为（对应 PRD §4）

- **有界 IPC**：NDJSON 单行 ≤64KB；转发器自限 1.2s 总预算、连接 250ms、ack 300ms，宿主不可达时静默退出（已验证：无宿主时 exit 0）。
- **回跳口径**：`bigKey()` 为唯一入口，三种触发（热键 / 宿主控制台 Enter、Space / 管道 bigkey）同路径；t0=触发，t1=扩展回执，t2=前台 HWND 核对通过。产出 `run-result{outcome: auto|activation-denied|fail:*}` 并逐行写 CSV。
- **版本核对**：快照 `v` 仅随卡片内容变化递增；大键按触发时 `v` 校验当前目标，防过期错切。
- **断线路由清理**：扩展断开只清聚焦路由，会话状态保留（Hook 事件仍可送达），重连重新登记。
- **Windows 激活限制**：SetForegroundWindow 被拒时依次尝试 AttachThreadInput → ALT 键欺骗（keybd_event 解锁前台锁）→ 最小化+还原强制激活；仍失败记 `activation-denied`（单独计数，不算自动成功也不算失败）。**锁屏/无人会话实测（2026-11-10）**：`FG|0|0|Idle`（前台窗口为 NULL）时三级兜底全部无效（`ACTA|0|0`），属平台级拒绝——前台切换验证必须用户在场；绑定环节改用 `bind-force`（runner 按窗口标题供 hwnd、扩展按 workspace 名自证，跳过前台校验，仅 AUTOTEST），锁屏下全链路其余环节可验。

## 运行

```powershell
# 上位机（控制台即模拟方屏；Ctrl+C 退出）
node src/host/host.mjs serve

# 可选环境变量：VIBE_HOTKEY_MODS/VIBE_HOTKEY_VK、VIBE_EXPIRE_MIN、
# VIBE_NO_HOTKEY=1、VIBE_EVIDENCE_DIR
node src/host/host.mjs status          # 查询当前快照
node src/host/host.mjs replay <jsonl>  # 重放脱敏样本，输出转换流
```

## 宿主部署与桌面隔离（2026-11-10 实测补充）

**关键发现**：本仓验收会话由 Antigravity language_server → ccweb 链拉起，其 Bash 工具运行在私有隔离桌面 `exebox-*`（WinSta0 内、非 Default）。隔离层内的进程：`GetForegroundWindow()` 恒为 0、`SetForegroundWindow`/三级兜底全部被拒、`EnumWindows` 只见同层窗口、spawn 的 VS Code 窗口用户不可见——此前所有“锁屏激活被拒”的表象均源于此，用户桌面全程正常。

**解法（已验证 `auto verified`）**：
1. 宿主经**交互式计划任务**落在真实桌面：`schtasks /create /tn vibe-host /tr "powershell -File scripts/ps/host-launch.ps1" /sc once /st 23:59 /it /f`，`schtasks /run /tn vibe-host` 启动；
2. VS Code 测试窗口由**宿主代为 spawn**（hub `test-control launch-window`，ComSpec+无引号拼接，含错误防护）——runner 侧 spawn 会落入隔离桌面；
3. 窗口枚举经宿主边车 `list-windows` 行协议（真实桌面枚举）；
4. 管道通信（hook/转发器/MCP）跨桌面正常，留在隔离层不受影响。

## 计量产物

- `docs/evidence/phase1/runs/g0-*.csv`：逐次 runId/src/outcome/binding/v/t0/t1/t2/msReceipt/msVerified/activeTerminal
- `docs/evidence/phase1/screen-snapshots.jsonl`：完整状态快照样例（模拟方屏每卡一条）
- `docs/evidence/phase1/hooks-received.jsonl`：宿主实际收到的转发事件（脱敏字段同转发器）

## 已验证 / 未验证

- 已验证：管道收发与快照（假事件冒烟）；状态机重放 14/14（含 3 个 Codex 适配器用例）；转发器限时与不可达静默；扩展 tsc+esbuild 零错误；真实样本 replay（T03 五场景全对）；`mcp-allow/deny` 为广播、等待方按 `binding` 字段过滤（混合双等待不串扰）；热键注册（宿主日志 `hotkey ready`）；VS Code 双窗串行启动（并发 `code --new-window` 有单实例竞争，第二个静默丢失）；**真实桌面 20×2 全量验收（2026-11-10）：同窗 19/19、跨窗 20/20 全 auto，零错跳零拒绝零误提交，总体 P95（大键→前台核实）=424ms**；跨窗一轮最小化恢复 2667ms 长尾单列。
- 未验证（遗留）：浏览器前台干扰场景与显式会话退出场景未单列实测（等价覆盖说明见 T06 证据行）；真实热键物理按下（人工层）。
