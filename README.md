# pi-workbuddy-connect

**（中文）** 把本机 **WorkBuddy 桌面 App**（国内版 WorkBuddy / 国际版 WorkBuddy AI）已登录的模型接入你自己的客户端（pi / 任何 OpenAI 兼容客户端），**使用你自己的账号与积分**。
**（English）** Bring the models already signed in inside your local **WorkBuddy desktop app** (CN / Global) into your own client (pi / any OpenAI-compatible client), **using your own account and your own credits**.

> ⚠️ **非官方 / Unofficial**：本项目与腾讯、WorkBuddy、WorkBuddy AI、DeepSeek 及其关联方**无任何隶属或背书关系**。本项目只复用**你本机**桌面 App 的登录态，使用**你自己的**账号与积分；不提供、不绕过任何计费或限流机制。
> This project is **not affiliated with or endorsed by** Tencent, WorkBuddy, WorkBuddy AI, or DeepSeek. It only reuses the login state of **your own** local desktop app and spends **your own** credits. It does not bypass any billing or rate-limit mechanism.

## 状态 / Status

**研究阶段（research phase）** —— 协议事实正在核实中：

- 上游同生态参考实现（公开、MIT）：[`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) —— 我们**只借鉴其"观察到的协议事实"**，实现为**净室重写**；其中 AAD 帧布局 / 信封字段名 / 一次性 helper 调用是为互操作所必需的逐字协议事实（已在 `src/credentials/at-rest.js`、`electron.js` 文件头注明，并附上游 MIT 许可与版权于 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)），其余为独立重表达。
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

## 快速开始（S3 只读 CLI）/ Quick start

> 当前阶段：**S3 只读 CLI**（`status` / `doctor`）。**不发推理请求**；`status` 只读一次计费接口来显示真实余额。
> Current phase: **S3 read-only CLI** (`status` / `doctor`). It never sends an inference request; `status` reads the billing endpoint once to show the real balance.

**零运行时依赖**，只用 Node 内置模块。Node 版本：`^22.19.0 || >=24.0.0`（与上游生态一致）。
**Zero runtime dependencies**, Node built-ins only. Node `^22.19.0 || >=24.0.0`.

```bash
# 从源码直接运行（尚未发布 npm）/ run from source (not published to npm)
git clone https://github.com/annacomnena/pi-workbuddy-connect
cd pi-workbuddy-connect
node bin/pi-workbuddy-connect.js status          # 人类可读（已脱敏）
node bin/pi-workbuddy-connect.js status --json   # 机器可读（已脱敏）
node bin/pi-workbuddy-connect.js doctor --json   # 诊断
```

安装为本地命令（可选）：`npm link` 后可用 `pi-workbuddy-connect ...`。

### 命令 / Commands

`status` — 读取本机登录态与真实余额。加密凭据会用 **App 自带的 Electron 二进制**在本地解封（不联网、不写 App 文件），随后**只读一次**计费接口。

`doctor` — 诊断为什么登录态不可用，给出失败原因码。默认**既不运行密钥 helper，也不联网**；`--decrypt` / `--network` 才逐项打开。

| 选项 | 说明 |
|---|---|
| `--variant <cn\|ai>` | 读取国内版 `WorkBuddy` 或国际版 `WorkBuddy AI`（默认 `cn`） |
| `--auth-file <path>` | 显式指定 auth 文件（env：`WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE`） |
| `--electron <path>` | 显式指定 App 二进制（env：`WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN`） |
| `--no-network` | 只做本地部分，不联系任何上游 |
| `--json` | 输出机器可读文档（**不含凭据本体**） |
| `--catalog` | `status`：实时刷新模型目录（多一次上游请求） |
| `--decrypt` | `doctor`：真正解封凭据（运行密钥 helper） |

### 失败原因码 / Reason codes

`credential-missing` · `credential-unreadable` · `credential-undecryptable` · `electron-not-found` · `electron-discovery-incomplete` · `credential-region-mismatch` · `session-dead` · `credit-exhausted` · `rate-limited` · `billing-unreachable` · `catalog-unreachable` · `network-disabled` · `upstream-client-error` · `upstream-server-error`

`doctor` 永远**不会**把「读不到凭据」悄悄降级成「未登录」：缺失、不可读、不可解密是三种不同的状态。

### 示例输出（**已脱敏**）/ Example output (redacted)

```
pi-workbuddy-connect status — WorkBuddy (cn)
auth file: ~\AppData\Local\ExampleVendor\Data\Public\auth\workbuddy-desktop.info [encrypted]
credential: desktop — decryptable (keyId 0123…cdef, matched true)
account: uid fix…33 · uin 123…12 · enterprise no
region: cn (www.workbuddy.cn)
token: access fixt…cdef · refresh fixt…3210
session: active, expires 2027-01-01T00:00:00.000Z (in 1000h)
balance: 1000 credit across 2 package(s)
  - Example Starter Pack: 600 / 800 (ends 2027-01-31T00:00:00.000Z)
  - Example Bonus Pack: 400 / 400 (ends 2027-02-01T00:00:00.000Z)
catalog: builtin (8 models) — built-in placeholder; the upstream roster churns, refresh to replace it
redaction self-check: ok
```

> 上例**全部为自造值**（`fixture-*` 风格），不含任何真实账号、余额或套餐数据。

> 所有 token / uid / uin 都做掩码；`status --json` 用同样的掩码，并在打印前对输出做 token 正则自检，命中即**拒绝输出**（fail-closed）。真实凭据值从不出现在输出、日志、测试夹具或本仓库。

## 凭据与安全 / Credentials and safety

- 桌面 App 的 auth 文件**永远只读**（本阶段运行不改变其 mtime）。
- 刷新后的 token 若写入，只写本仓自有目录：Windows `%APPDATA%\pi-workbuddy-connect\`，其它平台 XDG state home。POSIX 平台文件 `0600`、目录 `0700`；**Windows 无 POSIX mode**，`chmod` 是 no-op，副本仅与用户 profile 的继承 ACL 同私密性（本工具不承诺 0600），详见 [`docs/security.md`](./docs/security.md) §6。
- 解封密钥只在进程内存在，不落盘、不外发。
- 出站只允许三个上游域；本阶段只调用计费接口。
- 详见 [`docs/security.md`](./docs/security.md) 与 [`docs/compliance.md`](./docs/compliance.md)。

## 本次 S3 先导报告 / S3 pilot report

实现与实测证据（脱敏）见 [`docs/dev/S3-report.md`](./docs/dev/S3-report.md)。

## 开发 / Development

```bash
node --test        # 无网络单测；夹具自造，不读真实 token
```

```
bin/pi-workbuddy-connect.js     CLI 入口
src/cli.js                      status / doctor、参数解析、输出脱敏自检
src/credentials/                发现 → 信封解密 → 自留副本 → 生效凭据
src/upstream/                   域白名单、请求头族、错误分类（唯一出站模块）
src/billing/                    个人 / CN 企业计费解析
src/catalog/                    目录降级链 live → saved → builtin
src/util/                       mask / redact
```

导出入口后续供 S1 网关复用；本阶段**不**依赖 pi / subagent-win / DSH / cordis 任一 runtime。

## 许可 / License

[MIT](./LICENSE)
