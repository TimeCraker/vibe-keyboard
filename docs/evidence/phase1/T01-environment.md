# T01 环境与版本记录（软件子项）

日期：2026-11-10 · 体检脚本：`scripts/doctor.ps1`（原始输出见 `T01-doctor-latest.txt`）

## 版本清单（实际核查值）

| 工具 | 版本 | 来源 / 说明 |
| --- | --- | --- |
| Windows 11 Pro | 10.0.26300 | 本机 |
| Node.js | v24.16.0 | S0 上位机、转发器、扩展构建运行时 |
| npm | 11.13.0 | registry = npmmirror（本机全局配置） |
| VS Code（原生桌面版） | 1.144.1（commit 261c84cb，x64） | 扩展宿主 |
| Claude Code CLI | 2.1.286 | 受测 Agent，事件语义依据当日官方 Hooks 文档 |
| PowerShell | 5.1.26100.9711 | 边车脚本运行时（hotkey / win32ops） |
| Codex CLI | OpenAI.Codex 26.1103.7773.0（Microsoft Store 版） | 混合验证用；`~/.codex/config.toml` 已有用户 notify 配置，接入时不可覆盖 |

## .NET SDK 10（产品目标栈）——本次未能安装，S0 用 Node 等效实现

- `winget install Microsoft.DotNet.SDK.10`：安装器退出码 0x32（winget 日志：
  `Microsoft.DotNet.SDK.10.10.0.403-26-11-10-15-09-04.log`），需要提权重试。
- 官方 `dotnet-install.ps1`（dot.net）：`Invoke-WebRequest` 拉取脚本本身失败（直连不可达，退出时 `~/.dotnet` 未创建）。
- **对 S0 的影响**：无。上位机的状态机、命名管道、模拟方屏、热键、CSV 计量全部为 Node 零依赖实现，协议与语义与 PRD §3 一致；C#/.NET 10 仍是产品化目标栈，恢复命令（用户提权执行任一）：
  1. 管理员 PowerShell：`winget install Microsoft.DotNet.SDK.10 --source winget`
  2. 代理可用时：`powershell -File dotnet-install.ps1 -Channel 10.0 -InstallDir $env:USERPROFILE\.dotnet`
- 安装成功后按 `src/host/`（Node 参考实现 + 协议契约 `protocol/README.md`）移植 C#，行为以 `tests/hooks-replay.test.mjs` 重放断言为准。

## 固件工具链（T01 固件子项，硬件线并行推进时补齐）

- CMake / Ninja / Pico SDK：均未安装（预期内，见 `T01-doctor-latest.txt`）。**T01 保持未勾选**，待固件最小构建（T20 方案）完成后一并更新。

## 项目工件（本次产出）

- `src/vscode-extension/dist/extension.js`：esbuild 打包 + tsc 零错误（2026-11-10）。
- `src/host/`（Node）：`node --check` 全部通过；状态机重放测试 11/11（`node --test tests/hooks-replay.test.mjs`）。
