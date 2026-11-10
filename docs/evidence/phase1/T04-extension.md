# T04 VS Code 扩展：受管会话与终端绑定

日期：2026-11-10 · 工程：`src/vscode-extension`（TypeScript + esbuild，`tsc --noEmit` 0 错误）

## 命令

| 命令 | 行为 |
| --- | --- |
| `Vibe: 启动受管会话` | 在当前工作区创建终端：注入 `VIBE_BINDING_ID`（随机 8 位）+ `VIBE_PIPE`，运行 `claude`；终端名 `vibe <binding> (claude)` |
| `Vibe: 绑定本窗口` | 前置校验 `vscode.window.state.focused`（扩展焦点核对）→ PowerShell 采集前台 HWND → 校验进程名 `Code*`（VS Code 进程归属）→ `window-bound` 上报宿主 |
| `Vibe: 显示绑定状态` | OutputChannel：windowId / 连接状态 / HWND / 终端清单 |

## 管道协议（`protocol/README.md` v0）

- 激活即连 `\\.\pipe\vibe-keyboard-hub`，每窗口实例独立 `hello`（随机 windowId）；断线 2s 重连，重连后重报 window-bound + 终端清单。
- `terminal add/remove`：绑定 ↔ Terminal 对象映射；终端关闭自动上报 remove。
- `focus-request`（一次性 reqId，跨重连不重放）：`Terminal.show(false)` → 150ms 后回报**实际选中终端**（`activeTerminal`），错选时回执带 `active-terminal-mismatch`，由宿主裁决。
- AUTOTEST 模式（环境变量 `VIBE_AUTOTEST=1`）：接受 `start-session / dispose-terminal / bind-now / bind-force` 测试控制。`bind-force` 为锁屏安全绑定（2026-11-10 实测补充）：runner 按窗口标题枚举供 hwnd，扩展按 `workspace.name` 自证匹配后回 `window-bound`，跳过前台校验——因 SetForegroundWindow 在无前台会话（锁屏/Idle，`FG|0|0`）下被平台级拒绝，绑定与前台激活解耦后锁屏下全链路其余环节可验。
- 断线重连后自动重报 `window-bound` 与终端清单（宿主日志实测：重连即重报）。

## 设计要点

- **扩展不持有业务状态**：队列、屏幕、聚焦策略全在上位机；扩展只持有 Terminal 实例与窗口身份。
- **绑定 ID 注入而非探测**：启动时注入随机 `VIBE_BINDING_ID`，Hook 转发器带同一 ID 上报——不依赖终端标题/进程名匹配（重名场景天然免疫）。
- **工作区名/终端标题仅供显示**。
- 生命周期：窗口重载/关闭 → 连接断开 → 宿主清路由（会话状态保留）；重新打开后需重新绑定窗口（PRD 要求）。

## 验证状态

<!-- T06 联跑后回填：双终端选择准确性、跨窗口路由、重名/最小化场景 -->

- 已验证：tsc + esbuild 构建；协议消息与宿主枢纽匹配（冒烟）。
- 待验证（T06）：同窗口双终端选择、跨窗口路由、重名终端、窗口重载后旧绑定失效、`Terminal.show(false)` 实际选中回报准确性。
