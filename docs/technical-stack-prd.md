# Vibe Keyboard 技术栈与架构 PRD

状态：原型实施基线，待实机验证

产品需求与键位：[产品定义白皮书与 BRD](Vibe-Keyboard-BRD.pdf)

## 1. 范围与成功标准

有线原型先验证 Windows 上的完整链路。两项 Claude Code 任务并行，方屏显示当前待办，用户按大键回到屏上会话。首发硬件目标为 USB-C、2.4G 接收器、BLE 三模。三种模式都必须支持基础按键、方屏状态回传和大键定位，语音仍使用电脑或耳麦。设备运行时只选择一个连接模式和一台控制主机。

首轮固定 Windows 11、桌面版 VS Code、原生 Windows Claude Code CLI 的受测版本。先支持由扩展启动的内置终端。其他 IDE、外部终端、WSL／SSH 和任意已运行终端的自动接管后续按证据扩展。首件以静态状态卡和按需局部刷新为基线。桌宠动画、网页直连、云同步、无线 OTA 和板载麦克风另行排期。

## 2. 技术选型

| 层 | 选型 | 使用边界 |
| --- | --- | --- |
| Windows 上位机 | C#／.NET 10 LTS，CLI 起步，功能通过后加 WPF 托盘与设置界面 | 单进程维护会话、待办、设备连接和映射。USB 使用 Windows HID 接口，BLE 使用 Windows GATT API。配置用本地版本化 JSON，原子替换并保留可恢复的旧版。 |
| Agent 与 IDE 适配 | Claude Code Hooks ＋ TypeScript VS Code 扩展 | Hook 回报会话事件，扩展持有 Terminal 对象。Windows 前台激活单独验证。 |
| 有线固件 | Pico 2（RP2350）、Pico C/C++ SDK、TinyUSB、CMake／Ninja | 手头已有 RP2040 时可先复用。先实现键盘 HID＋厂商 HID 和 SPI 局刷。原型板不作为量产料号。 |
| 三模固件 | nRF52840 模组优先候选，nRF Connect SDK（Zephyr）、C、west／CMake | 键盘与接收器独立固件，共用协议与测试向量。BLE 用 HOGP＋自定义 GATT；2.4G 优先验证 ESB 双向链路。用锁定版本的实际样例验证 USB 复合设备、BLE 和 2.4G 后再确认模组。 |
| 方屏 | 优先带显存、支持窗口局刷的 SPI 方屏 | 约 2.1 英寸是目标，料号待实测。可先用 1.54 英寸 SPI 模组证明驱动和状态流程。屏幕缓冲按行或区域分配，驱动按模组维护。 |
| 语音 | Windows WASAPI 采集，本地 whisper.cpp 为首轮候选 | 用中文及中英混合实测延迟和可用性。先支持预览与复制，验证目标能安全接收文本后再开放插入。语音模型由电脑运行。 |
| PCB 与结构 | KiCad 10＋kicad-cli 为默认交付工具 | 外包若使用嘉立创 EDA Pro，报价时明确源工程格式。先拿屏幕规格书和实物，再冻结接口、结构堆叠及 PCB。 |

## 3. 架构与职责

    Claude Code Hooks ── 会话事件 ──► Windows 上位机
    VS Code 扩展 ◄──── 会话绑定与聚焦 ────► Windows 上位机
    Windows 上位机 ◄── 按键事件／状态快照 ──► 键盘
                USB 直连 | USB 接收器＋2.4G | BLE GATT

- **Windows 上位机拥有业务状态。** 同一串行状态处理路径维护待办、会话绑定和设备屏幕快照。按首次阻塞时间排序并按会话去重。选中项解除后回到队首。失联或证据不足时显示不可用。每种连接各有适配器，队列与业务规则共用。
- **扩展拥有终端实例。** 由扩展命令启动 Claude Code，在启动环境中注入本次会话绑定 ID。Hook 转发器携带绑定 ID 与 Claude Code session ID 上报。用进程或扩展实例的生命周期清理绑定。窗口句柄、终端对象任一失效时要求重新绑定。工作区名、终端标题仅供显示。S0 先用用户主动执行的窗口绑定命令，在该窗口仍处于前台时采集 HWND，同时核对 VS Code 进程归属和扩展的窗口焦点状态。最小化恢复、窗口重建与句柄复用纳入验证。
- **固件负责输入和显示。** 扫描、去抖、旋钮／摇杆仲裁、标准按键、状态卡和离线页留在设备端。渲染使用有界缓冲，局刷不能阻塞输入。接收器只做数据转发与标准 USB HID，业务状态仍由电脑管理。
- **先共享契约，再共享实现。** Pico 与 Nordic 各自接入本平台驱动。协议、测试向量和键位语义先共用，固件中已稳定的纯逻辑可迁移，避免为两个 SDK 提前搭建完整硬件抽象层。

## 4. 关键流程与故障处理

### 待办状态与精准回跳

1. 先在锁定版本记录脱敏 Hook 事件样本，覆盖等待权限、处理完成、取消、错误和退出。用实际观察确定状态转换。没有明确解除证据的事件保持未知或过期。Hook 转发器通过当前用户限定的本地 IPC 上报，失败时快速返回，不影响 Claude Code 权限流程。
2. 上位机将可见卡片和当前大键映射打包成快照。固件完成显示后更新可交互的快照版本。按大键时回报该版本。电脑仅允许跳到这个版本绑定的有效会话。待办已解除、映射变更或版本过期时提示刷新，避免错切。
3. Windows 请求激活已绑定窗口，扩展对目标调用 `Terminal.show(false)` 并回报实际选中的终端。上位机核对前台窗口和扩展回执。Windows 拒绝激活时通知用户点击激活，再校验目标。重复按大键仍只定位，批准或取消由用户在原会话完成。

### 语音

语音键按下时固定目标，松开时停止录音并打开可编辑预览。插入前重新校验会话和输入状态。只允许插入审阅后的文本，提交由用户操作。权限确认、工具执行中或输入状态未知时只提供复制。目标失效或适配器未通过插入测试时保留文本并提供复制。拔线、切模、断连或丢失松开事件时停止录音，录制设时长上限。默认音频和转写不写入诊断日志。

### 连接与协议

- 业务消息基线为 `HELLO`、`STATE_SNAPSHOT`、`STATE_APPLIED`、`INPUT_EVENT`、`ACTION_RESULT`、`HEARTBEAT`。会话键使用短期 opaque token，项目名长度有上限。设备只接收必要状态，无需提示词、目录绝对路径、录音或 Agent 凭证。
- 连接握手交换协议主版本、能力和连接代次。每条业务消息有序号。输入事件带当前快照版本，重试按连接代次与序号去重。状态按最新完整快照恢复，过期动作丢弃。跨重连禁止重放用户动作。
- USB 直连和接收器均提供标准键盘与独立厂商通道。BLE 基础按键走 HOGP，自定义服务独立承载应用消息，写入和通知需在授权连接中验证。传输适配器根据实际报告长度、ATT MTU 或空中载荷分帧。有界重组并测试分片缺失、重复、超时和超长输入。
- 2.4G 首轮验证键盘主动上报、接收器通过 ACK 载荷或明确的应答机制下发。无按键时也要按实测确定接收窗口，使状态可以更新。链路层确认与设备已经应用状态分开记账。协议、认证、加密和防重放在发售前评审，接收器只接受已配对设备。BLE 与 2.4G 按模式互斥启停。
- 模式切换时在可用的旧链路发送释放报告，再清理旧连接。接收器失联时也要主动向电脑发送释放报告。完成新握手和全量同步后恢复业务按键。桌面端退出后，基础键盘继续工作，方屏超时转为离线。

## 5. 阶段与验收

以下为验收门槛或试验口径。实测报告记录软件版本、硬件料号、测试环境、样本数及失败原因。

| 阶段 | 可开始的工作 | 放行条件 |
| --- | --- | --- |
| **S0 Windows 验证** | 现成键盘触发 CLI、扩展管理两个会话、模拟方屏输出 | 同窗口双终端和不同窗口各连续轮换 20 次，覆盖浏览器前台、最小化、重名和会话退出。零错跳、零误提交。激活受限单独计数，报告自动成功率、人工点击次数及耗时。两组预设常用路径自动成功均须至少 18／20，人工兜底不计入自动成功。未达标先修流程，再开板。 |
| **S1 有线功能原型** | 开发板、SPI 转接屏、实体大键、Windows 上位机 | 通过双会话上屏与回跳。方屏同时局刷时做至少 200 次按键操作，要求零丢键和零重复，并记录响应耗时。重复拔插 20 次并检查恢复和离线页。覆盖转写预览与目标失效。 |
| **S2 三模开发板验证** | 两块无线开发板验证接收器；键盘侧验证 BLE 和电源方案 | 三模各跑核心路径，切模与异常断开测试无粘键和动作重放。测试接收器重新插拔、BLE 休眠重连及 2.4G 干扰。分别记录输入、状态回传、重连耗时和待机／亮屏／使用时电流。 |
| **S3 首发工程样机** | 采购正式屏，冻结料号、天线、电池、充电和结构后画板 | 装配方运行离线产测并记录整机结果。开发方在实机跑三模、语音与大键闭环。以实测电流和典型亮屏占空验证续航目标，复核金属外壳下的射频表现、配对安全、恢复烧录和实际报价。 |

首板冻结前记录并确认三模各自的响应与重连目标、典型使用周期、可接受的电池容量与结构尺寸。S2 如未过关，继续用有线原型验证产品，保留三模首发目标并重新评估无线方案。正式采购以现货料号、参考设计和实测结果为准。

## 6. AI Coding 与工程交付

- 第一个实现阶段先提交 S0 Stage Spec，固定测试场景、验收口径和工作区范围。用真实脱敏 Hook 样本做状态重放，用模拟传输测试队列、过期事件和重连，再跑实机。模拟通过和实机通过分别记录。
- 实现时固定 .NET SDK、Node.js 依赖、Pico SDK 和 Nordic 工具链版本。提供 PowerShell 入口，把 `dotnet test`、扩展编译、`cmake --build`、`west build` 和产物位置纳入可复现的开发流程。首次烧录步骤、恢复入口和串口日志位置随版本记录。
- Codex、Claude Code 或 Cursor 可根据小型 Stage Spec 实现驱动适配、协议编解码和测试夹具。让工具输出构建与测试结果。窗口焦点、USB 枚举、射频、电流和手感用设备复核。
- 外包交付包含原理图和 PCB 源文件、Gerber、BOM、贴装坐标、结构 STEP、正式／产测固件、烧录恢复说明及逐台产测记录。KiCad 工程运行 ERC／DRC。封装、天线净空、充电电路和装配干涉由工程师对照实物复核。

## 技术依据

- [Claude Code Hooks](https://code.claude.com/docs/en/hooks) · [VS Code 扩展 API](https://code.visualstudio.com/api/references/vscode-api)
- [Windows 前台激活限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) · [Windows GATT 客户端](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client) · [.NET 支持周期](https://learn.microsoft.com/en-us/dotnet/core/releases-and-support)
- [Pico C/C++ SDK](https://datasheets.raspberrypi.com/pico/raspberry-pi-pico-c-sdk.pdf) · [Nordic 无线规格](https://docs.nordicsemi.com/r/bundle/ps_nrf52840/page/radio.html) · [nRF Connect SDK 样例验证](https://docs.nordicsemi.com/r/bundle/nrf-connect-vscode/page/get_started/quick_debug.html/how-to-test-an-application)
- [Zephyr west](https://docs.zephyrproject.org/latest/develop/west/index.html) · [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [KiCad CLI](https://docs.kicad.org/10.0/en/cli/cli.html)
