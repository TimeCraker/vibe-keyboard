# 硬件联调说明（S1 接口预留 · T02/T07 硬件线对接用）

本文面向硬件线（Pico 2 + ST7789 240×240 + 实体大键），说明 S0 软件链路为
固件预留的接口、替换点和联调时需要的证据。协议细节以
[protocol/README.md](../../protocol/README.md) 与 PRD §4「连接与协议」为准。

## 1. S0 → S1 的替换点（设备接入时）

| S0 组件 | S1 替换为 | 不变的部分 |
| --- | --- | --- |
| `scripts/ps/hotkey-sidecar.ps1`（全局热键模拟大键） | 实体大键（键盘 HID 消费键或厂商 HID 自定义键） | `Hub.bigKey()` 入口与全部聚焦流程 |
| `lib/screen.mjs`（控制台静态卡 + JSONL 快照） | USB 厂商 HID 通道下发 `STATE_SNAPSHOT`，固件本地绘制 | 状态机与快照结构（v/short/state/pos/total/keyLabel） |
| 控制台 CSV 人工触发 | 固件回报 `INPUT_EVENT`（带快照版本 v） | 版本核对与过期防错切逻辑 |

## 2. 固件需要实现的协议（一期最小集）

- `HELLO`（协议主版本、能力、连接代次）→ 上位机回 `HELLO_ACK`
- `STATE_SNAPSHOT`（完整状态卡，含版本号 v）→ 固件显示后回 `STATE_APPLIED(v)`
- `INPUT_EVENT`（大键按下，携带显示版本 v）→ 上位机回 `ACTION_RESULT`
- `HEARTBEAT` 双向；断链超时转离线页

约束：项目短名 ≤ 规定长度（屏幕字库实测后冻结）；固件只接收必要状态，
不接收提示词、绝对路径、录音或凭证；每条消息带序号，重试按连接代次+序号去重。

## 3. 联调需要的软件侧证据（S0 已产出 / S1 复用）

- `docs/evidence/phase1/screen-snapshots.jsonl`：真实快照样例，可离线回放给固件渲染
- `docs/evidence/phase1/runs/g0-*.csv`：回跳计时口径（t0 触发→t2 前台核对），S1 对比实体键时延
- `tests/fixtures/hooks-replay.jsonl`：脱敏事件重放集，状态机行为回归用

## 4. 上位机侧接口预留（已就位）

- 快照数据结构与 `v` 版本语义已按可序列化设计（JSON），HID 传输适配器只需
  实现分帧/重组（报告长度按实测确定），不碰状态机。
- 大键入口已参数化来源（`src: hotkey|console|pipe`），固件接入后新增
  `src: device`，聚焦流程零改动。
- 连接层抽象：`Hub` 不感知传输；新增 HID 适配器时实现「收 INPUT_EVENT /
  发 STATE_SNAPSHOT」即可，与命名管道并列。

## 5. 联调顺序建议（S1 验收门槛对应）

1. HID 枚举与 HELLO 握手（重复插拔 20 次，恢复 + 离线页）
2. 快照下发与方屏局刷（状态→显示 P95 ≤ 2s，局刷期间 ≥200 次按键零丢/零重）
3. 实体大键端到端回跳（对齐 S0 CSV 口径，P95 ≤ 1s）
