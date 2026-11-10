# Vibe Keyboard

面向 Windows 的桌面 AI 控制台。方屏显示哪个 Agent 会话需要处理，按下屏下大键即可尝试回到对应会话。大键支持软件改绑。

## 项目阶段

- **功能原型**采用 USB-C 有线连接。先验证两项任务并行时的状态提示、精准会话跳转，以及方屏局刷与按键输入并发。
- **首发产品设计目标**为 USB-C 有线、2.4G USB 接收器和 BLE 蓝牙三模。无线原型需验证按键上报、方屏状态回传、重连和续航。
- **按住说话**列入首发功能计划，在核心闭环验证通过后开发和单独验收。
- 当前为产品定义与原型规划阶段，三模为设计目标，最终硬件选型待样机验证。

## 产品文档

[产品定义白皮书与 BRD · 方屏大键版 · 评审修订](docs/Vibe-Keyboard-BRD.pdf)

BRD 记录产品布局与原有需求。工程实施以以下 Markdown 的一期范围与放行条件为准；PDF 中的目标尺寸、屏幕和历史成本不能直接用作采购、开板或报价依据。

[技术栈与架构 PRD](docs/technical-stack-prd.md)记录实现选型、软硬件协议、阶段验收和外包交付。

[一期硬件实施与免焊交付规范](docs/phase1-hardware.md)：采购基线、接口与引脚预算、USB-C、电源、结构、外包询价和发货验收。

[一期执行任务清单 / Stage Spec](docs/phase1-tasks.md)：按依赖执行，覆盖你的操作、软件、固件、硬件合作方与真实闭环验收。当前实施任务完成 **0/24**，尚无样机或软件验收证据。

一期完成指一台完整装配的 USB-C 有线样机及可安装软件：21 键、方屏、旋钮、五向摇杆可用，两个受支持的真实会话可准确上屏和回跳，拔插及退出恢复通过。模块验证只是中间步骤。三模、语音和量产不作为一期完成条件，原有首发目标不因此取消。

## 一期软件启动步骤（S0）

前置：Node ≥ 24、原生 VS Code、Claude Code CLI 已登录。

```powershell
# 1. 环境体检（版本清单写入 docs/evidence/phase1/T01-doctor-latest.txt）
pwsh -File .\scripts\doctor.ps1

# 2. 构建 + 软件测试
pwsh -File .\scripts\build.ps1 -Target All
pwsh -File .\scripts\test.ps1 -Suite Software

# 3. 启动上位机（控制台即模拟方屏；Ctrl+Alt+V 为模拟大键，Enter/Space 亦可触发）
node .\src\host\host.mjs serve

# 4. 打开 VS Code 窗口并装扩展（开发模式）
code --extensionDevelopmentPath .\src\vscode-extension .\tests\fixtures\sandbox-A
#   在窗口内: 命令面板 → "Vibe: 绑定本窗口"，再 → "Vibe: 启动受管会话"

# 5. 查看当前快照 / 重放脱敏样本
node .\src\host\host.mjs status
node .\src\host\host.mjs replay .\tests\fixtures\hooks-replay.jsonl
```

逐次验收记录、状态快照样例与硬件联调说明见 `docs/evidence/phase1/`。
