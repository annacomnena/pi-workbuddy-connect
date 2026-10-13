# pi-workbuddy-connect

**（中文）** 把本机 **WorkBuddy 桌面 App**（国内版 WorkBuddy / 国际版 WorkBuddy AI）已登录的模型接入你自己的客户端（pi / 任何 OpenAI 兼容客户端），**使用你自己的账号与积分**。
**（English）** Bring the models already signed in inside your local **WorkBuddy desktop app** (CN / Global) into your own client (pi / any OpenAI-compatible client), **using your own account and your own credits**.

> ⚠️ **非官方 / Unofficial**：本项目与腾讯、WorkBuddy、WorkBuddy AI、DeepSeek 及其关联方**无任何隶属或背书关系**。本项目只复用**你本机**桌面 App 的登录态，使用**你自己的**账号与积分；不提供、不绕过任何计费或限流机制。
> This project is **not affiliated with or endorsed by** Tencent, WorkBuddy, WorkBuddy AI, or DeepSeek. It only reuses the login state of **your own** local desktop app and spends **your own** credits. It does not bypass any billing or rate-limit mechanism.

## 状态 / Status

**S3 只读 CLI 已实现并实测**（`status` / `doctor`，60+ 单测）；**S1 本地 OpenAI 兼容网关已实现**（`serve`，四道闸 / SSE / 目录降级 / per-model 冷却 / SF-6 加密副本），真实推理已跑通一轮（见 [`docs/dev/S1-report.md`](./docs/dev/S1-report.md)）。协议事实来源：

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
- 把模型以 **OpenAI 兼容**方式暴露在 `127.0.0.1`（`serve`；四道闸 + 随机密钥）
- token 到期前按上游契约刷新，**只写自留副本**（加密存储，不回写 App 文件）

**不做 / Don't**

- ❌ 多账号池 / 账号轮换（multi-account pooling）
- ❌ 自动签到 / 刷额度（automated check-in / credit farming）
- ❌ 绕过计费、限流或任何访问控制（no billing/rate-limit bypass）
- ❌ 上传、外传或落库任何凭据 / token（no credential exfiltration — never commit tokens）
- ❌ 本地余额预扣 / 记账 / 闸门（billing is the upstream's, per token, server-side）
- ❌ 监听非回环地址、无密钥暴露、局域网或公网共享
- ❌ 冷却期内换账号 / 换身份重试（no identity switching to dodge a rate limit）

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

## 本地网关（S1 · OpenAI 兼容）/ Loopback gateway

在你的机器上开一个 **只绑 `127.0.0.1`** 的 OpenAI 兼容端点，把本机 App 的登录态接到任意客户端。
Starts an OpenAI-compatible endpoint bound to `127.0.0.1` only, so any client can reuse your local app's sign-in.

```bash
node bin/pi-workbuddy-connect.js serve                 # 默认 127.0.0.1:8317
node bin/pi-workbuddy-connect.js serve --port 9000     # 换端口（env：WORKBUDDY_GATEWAY_PORT）
node bin/pi-workbuddy-connect.js serve --variant ai    # 国际版 WorkBuddy AI（需已安装并登录）
```

启动时会把**实际监听地址与端口**写进本仓自有目录的 `endpoint.json`（`0600`；Windows 上 `chmod` 是
no-op，实际只与用户 profile 的继承 NTFS ACL 同私密性——文件里**不含密钥**）。网关密钥是**每次运行随机生成**
的 32 字节串，存在自有目录的 `gateway.json`，可用环境变量 `WORKBUDDY_GATEWAY_TOKEN` 覆盖。

### 路由 / Routes

| 路由 | Bearer | 说明 |
|---|---|---|
| `GET /healthz` | **不需要** | 状态 / 版本 / 账号掩码摘要 / 是否可解密 / 冷却状态。不含任何凭据；**本机任意进程可读**（无鉴权） |
| `GET /v1/models` | 需要 | OpenAI `{object:"list"}`，id 形如 `workbuddy/<modelId>`，含分组、上下文窗口、能力元数据；目录按 **live → saved → builtin** 降级并标明来源（`workbuddy_source`）。`?refresh=1` 强制实时刷新 |
| `POST /v1/chat/completions` | 需要 | 支持 `stream:true`（SSE）与非流式；`stream:false` 时网关把上游 SSE 折叠成一个 `chat.completion` |
| `GET /v1/workbuddy/credits` | 需要 | **非标准便利端点**（文档明示）：脱敏后的余额/资源包只读视图 |

### 四道闸 / Four inbound gates

`loopback bind is not a trust boundary`——本机任意进程、以及 DNS rebinding 页面都能访问 `127.0.0.1`，
所以在**路由分发 / 上游调用之前**逐条检查：

1. **Host 必须是回环**（`127.0.0.1` / `localhost` / `[::1]`）→ 否则 `403`
2. **Origin 若存在必须是回环**（无 Origin 的非浏览器客户端放行）→ 否则 `403`
3. **`Authorization: Bearer` 必须等于本进程密钥**（`timingSafeEqual` 常量时间比较；长度不同直接拒）→ 否则 `401`
   （`/healthz` 例外：它只回状态，不含凭据，见 `docs/security.md`）
4. **非 GET 请求必须声明 `application/json`** → 否则 `415`

（精确顺序：Host → Origin → **路由匹配（未命中即 `404`）** → Bearer → 非 GET JSON → 方法；即 `404`
先于 Bearer，未授权者可区分路由是否存在，但无数据暴露、不调上游。）

另有请求体上限（64 MiB）与上游流中断的**截断信令**：**零字节已转发**时回 `502` + OpenAI 错误体；
**已转发部分帧**时在 `data: [DONE]` 之前补一条 `workbuddy_truncated` 帧（与非流式折叠的
`workbuddy_truncated` 标记一致），使残缺回复与完整回复可区分。状态码语义分清：**403 = 不是回环调用方**，
**401 = 没有/错误的密钥**，**415 = 媒体类型不对**。

### 计费 / Billing

**网关不在本地做任何余额预扣、记账或闸门，也不主张某次请求被扣费。** 用量/计费由**上游服务端计算**：`usage` 由上游给出，
余额只在你显式请求 `credits` 时旁路读取。唯一的准入控制是**上游自己用 429/402 表示的 per-model 冷却**：
某个模型被限流后进入冷却（读 `Retry-After` / 响应体中的时刻，上限 2 小时），冷却期内对该模型的请求**立即**
返回 `429` + `Retry-After`（不排队重试、**不换账号/身份**、不重试风暴），其他模型不受影响；冷却状态出现在
`/healthz` 与错误体里。

### 客户端接入 / Client setup

任意 OpenAI 兼容客户端（`baseURL = http://127.0.0.1:8317/v1`，`apiKey` = 网关密钥）即可。直接用 `curl`：

```bash
TOKEN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.APPDATA+'/pi-workbuddy-connect/gateway.json','utf8')).token)")
curl -s http://127.0.0.1:8317/healthz                     # 不需要密钥
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8317/v1/models
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"model":"workbuddy/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'   http://127.0.0.1:8317/v1/chat/completions
```

pi（或任何读 `models.json` 的客户端）可以按其 OpenAI 兼容 provider 语法指向本端点，例如：

```json
{ "providers": { "workbuddy": {
  "type": "openai-completions",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKey": "<gateway.json 里的 token>",
  "models": [ { "id": "workbuddy/deepseek-v4.1-flash" } ]
} } }
```

停止：`Ctrl+C`（会删除 `endpoint.json`）。**Windows 上用 `taskkill /F` 强杀不会触发清理**，此时
`endpoint.json` 会残留，可手动删除。

### 已知限制 / Known limitations

- **CN 企业分支未验证**：`enterpriseId` 非空的 CN 账号走企业额度端点，代码与单测齐备但**无实机证据**。
- **国际版（WorkBuddy AI）与 RoW 变体未验证**：本机只装了国内版；`ai` 变体的 UA / 目录 / region 分支仅有代码路径。
- **ToS 风险**：本网关依赖**非官方私有接口**，使用可能违反上游条款，后果自负；默认低频、只读优先，出现风控请停用。
- **余额变化不可立即观测**：真实推理后余额字段可能不立刻变化（本次实测前后均 `total 692`），因此「服务端按 token 扣费」的证据是上游返回的 `usage`（含 `credit` 字段），而非余额差值。
- **冷却上限 2 小时**：来自外部观察，非本机实测。
- **`credits` 端点是本仓自造的便利端点**，不是上游或 OpenAI 标准的一部分。

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
bin/pi-workbuddy-connect.js     CLI 入口（status / doctor / serve）
src/cli.js                      status / doctor / serve、参数解析、输出脱敏自检
src/serve.js                    网关装配：store + client + session + catalog + cooldown + server
src/credentials/                发现 → 信封解密 → 自留副本（SF-6 加密）→ 刷新（单飞 + 退避）
src/credentials/protection.js   SF-6：AES-256-GCM 封存 + Windows DPAPI / macOS Keychain / Linux libsecret
src/credentials/session.js      到期前刷新、失败退避、fail-closed
src/protocol/body.js            OpenAI → 上游 body 映射（强流式 / tool_choice / developer / effort）
src/upstream/                   域白名单、请求头族、错误分类（唯一出站模块，含 chat/refresh）
src/gateway/                    回环 HTTP：四道闸、路由、SSE 折叠、per-model 冷却、密钥/端点文件
src/billing/                    个人 / CN 企业计费解析
src/catalog/                    目录降级链 live → saved → builtin
src/util/                       mask / redact
```

导出入口后续供 S1 网关复用；本阶段**不**依赖 pi / subagent-win / DSH / cordis 任一 runtime。

## 许可 / License

[MIT](./LICENSE)
