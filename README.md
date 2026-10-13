# pi-workbuddy-connect

**（中文）** 把本机 **WorkBuddy 桌面 App**（国内版 WorkBuddy / 国际版 WorkBuddy AI）已登录的模型接入你自己的客户端（pi / 任何 OpenAI 兼容客户端），**使用你自己的账号与积分**。
**（English）** Bring the models already signed in inside your local **WorkBuddy desktop app** (CN / Global) into your own client (pi / any OpenAI-compatible client), **using your own account and your own credits**.

> ⚠️ **非官方 / Unofficial**：本项目与腾讯、WorkBuddy、WorkBuddy AI、DeepSeek 及其关联方**无任何隶属或背书关系**。本项目只复用**你本机**桌面 App 的登录态，使用**你自己的**账号与积分；不提供、不绕过任何计费或限流机制。
> This project is **not affiliated with or endorsed by** Tencent, WorkBuddy, WorkBuddy AI, or DeepSeek. It only reuses the login state of **your own** local desktop app and spends **your own** credits. It does not bypass any billing or rate-limit mechanism.

## 状态 / Status

**研究阶段（research phase）** —— 协议事实正在核实中：

- 上游同生态参考实现（公开、MIT）：[`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) —— 我们**只借鉴其"观察到的协议事实"**，实现为**净室重写**；如确实复用了其代码片段，会在文件头保留其版权与许可声明。
- 本仓目标：**独立插件**（不依赖、也不集成进任何特定 harness 的 runtime），可独立运行。

机制与协议文档已在 `docs/` 公布：

- [`docs/mechanism.md`](./docs/mechanism.md) — 工作机制（登录态来源、端点、积分语义、线协议要点）
- [`docs/protocol.md`](./docs/protocol.md) — 端点与字段参考
- [`docs/security.md`](./docs/security.md) — 凭据处理与回环网关安全模型
- [`docs/compliance.md`](./docs/compliance.md) — 非官方声明、边界与 Do-NOT 清单

> 文档只写**字段名与结构**，不含任何凭据值、账号标识或个人数据。

## 范围与不做的事 / Scope

**做 / Do**

- 读取本机 WorkBuddy App 的**登录态**（只读）
- 列出可用模型与**积分余额**（真实查询计费）
- 把模型以 **OpenAI 兼容**方式暴露给本机客户端

**不做 / Don't**

- ❌ 多账号池 / 账号轮换（multi-account pooling）
- ❌ 自动签到 / 刷额度（automated check-in / credit farming）
- ❌ 绕过计费、限流或任何访问控制（no billing/rate-limit bypass）
- ❌ 上传、外传或落库任何凭据 / token（no credential exfiltration — never commit tokens）

## 开发 / Development

（待实现落地后补全：安装、构建、配置、验收步骤）

## 许可 / License

[MIT](./LICENSE)
