# pi-workbuddy-connect

**（中文）** 把本机 **WorkBuddy 桌面 App**（国内版 WorkBuddy / 国际版 WorkBuddy AI）已登录的模型接入你自己的客户端（pi / 任何 OpenAI 兼容客户端），**使用你自己的账号与积分**。
**（English）** Bring the models already signed in inside your local **WorkBuddy desktop app** (CN / Global) into your own client (pi / any OpenAI-compatible client), **using your own account and your own credits**.

> ⚠️ **非官方 / Unofficial**：本项目与腾讯、WorkBuddy、WorkBuddy AI、DeepSeek 及其关联方**无任何隶属或背书关系**。本项目只复用**你本机**桌面 App 的登录态，使用**你自己的**账号与积分；不提供、不绕过任何计费或限流机制。
> This project is **not affiliated with or endorsed by** Tencent, WorkBuddy, WorkBuddy AI, or DeepSeek. It only reuses the login state of **your own** local desktop app and spends **your own** credits. It does not bypass any billing or rate-limit mechanism.

## 状态 / Status

**S3 只读 CLI 已实现并实测**（`status` / `doctor`，60+ 单测）；**S1 本地 OpenAI 兼容网关已实现**（`serve`，四道闸 / SSE / 目录降级 / per-model 冷却 / SF-6 加密副本），真实推理已跑通一轮（见 [`docs/dev/S1-report.md`](./docs/dev/S1-report.md)）；**S2 已实现**：`install-provider` / `uninstall-provider` 把网关写成 pi 的 `workbuddy` provider（只动自己那一段、先备份、幂等、离线），可在 subagent-win 里用 `model: "workbuddy/<id>"`（见 [`docs/dev/S2-report.md`](./docs/dev/S2-report.md)）；**S2.1 已实现**：模型暴露**可配置**（`models` 子命令，单一配置源 `gateway.json.models`，`serve` / `install-provider` 三处共用）、**端口占用自动挑空闲端口**（默认 `8799`，实际端口写入 `endpoint.json`，`install-provider` 默认跟随该端口）（见 [`docs/dev/S2.1-report.md`](./docs/dev/S2.1-report.md)）。协议事实来源：

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
| `--models <a,b>` | `serve`/`install-provider`：仅本次暴露这些模型（不落盘） |
| `--api-key-env <NAME>` | `install-provider`：写入 `$NAME` 插值而非明文密钥（**推荐**） |

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
node bin/pi-workbuddy-connect.js serve                 # 首选 127.0.0.1:8799
node bin/pi-workbuddy-connect.js serve --port 9000     # 换端口（env：WORKBUDDY_GATEWAY_PORT）
node bin/pi-workbuddy-connect.js serve --variant ai    # 国际版 WorkBuddy AI（需已安装并登录）
```

**端口策略**：`--port` > `WORKBUDDY_GATEWAY_PORT` > `gateway.json.port` > 默认 `8799`。首选端口若**已被占用**（例如本机曾把 `8317` 让给 `cli-proxy-api.exe`/EasyCLIProxyAPI），
`serve` 会**自动改挑一个空闲端口**并把**实际端口**写进 `endpoint.json`（含 `baseUrl`/`pid`/`startedAt`）；
显式 `--port` 被占用时则**明确报错**而不悄悄改口。Windows 上“两个进程绑同一端口”也可能“成功”，所以占用检测是**主动探测**而非仅依赖 bind 失败。

启动时会把**实际监听地址与端口**写进本仓自有目录的 `endpoint.json`（`0600`；Windows 上 `chmod` 是
no-op，实际只与用户 profile 的继承 NTFS ACL 同私密性——文件里**不含密钥**）。网关密钥是**每次运行随机生成**
的 32 字节串，存在自有目录的 `gateway.json`，可用环境变量 `WORKBUDDY_GATEWAY_TOKEN` 覆盖。

### 路由 / Routes

| 路由 | Bearer | 说明 |
|---|---|---|
| `GET /healthz` | **不需要** | 状态 / 版本 / 账号掩码摘要 / 是否可解密 / 冷却状态。不含任何凭据；**本机任意进程可读**（无鉴权） |
| `GET /v1/models` | 需要 | OpenAI `{object:"list"}`，`id` 是**上游裸 id**（如 `deepseek-v4.1-flash`），并附 `workbuddy_prefixed_id`（旧拼写 `workbuddy/<modelId>`）与列表级 `workbuddy_id_style:"bare"`；**只返回当前暴露集合**（`workbuddy_exposed` 字段说明模式/总数）；含分组、上下文窗口、能力元数据；目录按 **live → saved → builtin** 降级并标明来源（`workbuddy_source`）。`?refresh=1` 强制实时刷新。请求侧**带不带 `workbuddy/` 前缀都接受** |
| `POST /v1/chat/completions` | 需要 | 支持 `stream:true`（SSE）与非流式；`stream:false` 时网关把上游 SSE 折叠成一个 `chat.completion`。**未暴露的模型**返回 `404` + `error.code="model_not_found"` + `workbuddy_reason_code="model-not-exposed"`（**策略过滤，非安全边界**） |
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

任意 OpenAI 兼容客户端（`baseURL = http://127.0.0.1:<port>/v1`，`apiKey` = 网关密钥）即可；**端口以 `endpoint.json` 的实际 `port` 为准**（占用时会自动改挑），不要写死 `8799`。直接用 `curl`：

```bash
TOKEN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.APPDATA+'/pi-workbuddy-connect/gateway.json','utf8')).token)")
# 实际端口以 endpoint.json 为准（占用时 serve 会自动改挑）
PORT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.env.APPDATA+'/pi-workbuddy-connect/endpoint.json','utf8')).port))")
curl -s http://127.0.0.1:$PORT/healthz                     # 不需要密钥
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/v1/models
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json'   -d '{"model":"workbuddy/deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":16}'   http://127.0.0.1:$PORT/v1/chat/completions
```

**接入 pi 推荐用 `install-provider`**（见下一节）：它替你写 `~/.pi/agent/models.json` 里 `providers.workbuddy`
那一段，不需要手写 JSON。

## 接入 pi / subagent-win（S2）/ Use from pi and subagent-win

把网关变成 pi 的一个模型 provider，于是模型引用就是 **`workbuddy/<modelId>`**（例如 `workbuddy/glm-5.3`），
在 subagent-win 里直接写 `model: "workbuddy/glm-5.3"` 即可。

```bash
# 1) 先刷一次模型目录（可选；不刷就用上次缓存或内置占位表）
node bin/pi-workbuddy-connect.js status --catalog

# 2) 选择要暴露的模型（写入 gateway.json.models；已安装时会自动同步 models.json）
node bin/pi-workbuddy-connect.js models set deepseek-v4.1-flash
#   或： models add glm-5.3 / models remove glm-5.3 / models all / models list

# 3) 看一眼要写什么（不落盘、不备份）
node bin/pi-workbuddy-connect.js install-provider --dry-run

# 4) 真正写入（自动先备份 ~/.pi/agent/models.json）
#    推荐：用环境变量插值，不在 models.json 里落明文密钥（见下）
node bin/pi-workbuddy-connect.js install-provider --api-key-env WORKBUDDY_GATEWAY_TOKEN

# 5) 只用只读命令验证 pi 能解析
pi --offline --list-models workbuddy

# 不需要时移除（只删我们那一段）
node bin/pi-workbuddy-connect.js uninstall-provider
```

### 模型暴露（S2.1）/ Model exposure

暴露哪些模型是**一个设置**，存在本仓自有目录的 `gateway.json`：

```json
{ "models": { "mode": "allowlist", "expose": ["deepseek-v4.1-flash"] } }
```

`mode` 为 `all`（全部暴露，默认）或 `allowlist`（只暴露 `expose` 里的）。该设置是**单一配置源**，三处共用：

| 消费方 | 行为 |
|---|---|
| `serve` `GET /v1/models` | 只列出暴露集合（响应带 `workbuddy_exposed`） |
| `serve` `POST /v1/chat/completions` | **未暴露**的模型 → `404` + `error.code="model_not_found"` + `workbuddy_reason_code="model-not-exposed"` |
| `install-provider` | 只把暴露集合写进 `~/.pi/agent/models.json` 的 `providers.workbuddy.models[]`，于是 pi / subagent-win 不会看到被隐藏模型的歧义短名 |

> 这是**策略过滤，不是安全边界**：能访问回环网关的人已经持有 bearer 密钥。它不是凭据、也不是计费控制。

CLI：`models list` / `models set <id...>` / `models add <id>` / `models remove <id>` / `models all`（均支持 `--json`）；
`serve --models a,b` / `install-provider --models a,b` 是**仅本次进程**的覆盖（不落盘）。非法 id（不在目录里）**明确报错并列出候选**，不静默接受。

**幂等联动**：`models set/add/remove` 之后，若 `models.json` 里已安装 `providers.workbuddy`，命令会**自动同步**（同一次调用里重写那段）；
若未安装，会提示“需重跑 install-provider”。两者都会在输出里说清（`sync:` 行）。

### 端口与 `models.json` 的 baseUrl（S2.1）

`install-provider` 生成的 `baseUrl` 默认**跟随实际网关**：`--port`/env 优先；否则读 `endpoint.json` 的实际端口；
否则 `gateway.json.port`；否则默认 `8799`。因此 `serve` 因端口占用而改口时，重跑一次 `install-provider` 即可把 `baseUrl` 对齐。

**身份复核（S-6）**：只凭 pid 判活不够（Windows 会复用 pid，陈旧 `endpoint.json` 可能指向别人的活进程）。
所以采信 `endpoint.json` 前会**向该端口做一次回环 `GET /healthz`**，确认 `service` 是本网关；
答案不是本服务（pid 被复用/端口易主）则**不采信**，回退到 `gateway.json.port`/默认并给 `warning:`。
残余边界：若探活成功、但网关恰好在探活与写入之间退出，`baseUrl` 会短暂指向一个已关闭的端口（重跑 `install-provider` 即可）。
探活只走 `127.0.0.1`，不带密钥、不出网。

### 命令语义 / What the commands guarantee

| | 行为 |
|---|---|
| 写入范围 | 只动 `providers.workbuddy` **一个成员**：按字节拼接进原文件，其余 provider 的文本、顺序、缩进、换行（CRLF）**逐字节不变** |
| 备份 | 每次真正写入前复制到 `~/.pi/agent/config-backups/models.json.<UTC 时间戳>.bak`（已有同名时加 `-2`、`-3`…） |
| 幂等 | 内容已经一致时报告 `changed: false`，**不写文件、不新增备份** |
| `--dry-run` | 只打印 unified diff（密钥以 `<gateway bearer secret>` 占位），**不落盘、不备份** |
| 联网 | **不联系任何上游**、不运行 App 密钥 helper：模型列表取本仓 `workbuddy-catalog.json` 缓存（`status --catalog` 刷新），没有缓存就用内置占位表并在 `warnings` 里说明。仅当存在 `endpoint.json` 时会向该 `127.0.0.1` 端口做一次 `/healthz` 身份探活（S-6），不带密钥、不出网 |
| 密钥 | 网关密钥不存在则生成（写入自有目录 `gateway.json`）；`models.json` 里默认写**字面值**（该文件与 `gateway.json` 同为用户私有）。**推荐**：先设 `WORKBUDDY_GATEWAY_TOKEN`（同时供 `serve` 与 pi 读取），再 `install-provider --api-key-env WORKBUDDY_GATEWAY_TOKEN`，则 `models.json` 只存 `$WORKBUDDY_GATEWAY_TOKEN`，**不落明文副本**。密钥来自 `WORKBUDDY_GATEWAY_TOKEN` 时自动改写插值。用字面值时命令输出**首行**会给出 `PLAINTEXT SECRET` 警告。**命令输出永不打印密钥**，并走既有的 token 自检 |
| 其它选项 | `--port <n>` 决定 baseUrl（默认跟随 `endpoint.json`，无则 `gateway.json.port`，无则 `8799`）；`--models a,b` 仅本次覆盖暴露集合；`--models-json <path>` 改写别处的文件；`--json` 机器可读 |

### 使用示例 / Usage examples

```js
// subagent-win：用完整 provider/id 指定（推荐；短名在有歧义时会报错，见下）
subagent-win({ agent: "general", model: "workbuddy/glm-5.3", task: "..." });

// 或把它设为某个 agent 的默认模型
// /sub-models implementer workbuddy/glm-5.3
// /sub-models implementer fallback Zhipu/glm-5.3
```

**前提 / Preconditions**

1. **网关必须在线**：`node bin/pi-workbuddy-connect.js serve`。`install-provider` 默认读 `endpoint.json` 的实际端口；
   若你显式传过 `--port`，请保证两者一致。`pi --list-models` 不需要网关（它只读 `models.json`），但**发请求**需要。
2. **登录态有效**：网关复用本机 App 的登录态；过期需在 App 里重新登录。
3. **模型可用**：只列 `status --catalog` 那一刻的 `cli` 名单；上游名单变动后重跑 `install-provider`。
4. **不要用会歧义的短名**：`glm-5.3` 这类短名在 `Zhipu/glm-5.3` 与 `workbuddy/glm-5.3` 同时存在时，
   subagent-win 的别名展开会以 `Ambiguous model alias` 拒绝（`subagent-win/extensions/index.ts` 的
   `normalizeModelRef`）——请始终写 `workbuddy/<modelId>`。

### 故障排查 / Troubleshooting

| 现象 | 处理 |
|---|---|
| `pi --list-models workbuddy` 没有结果 | 看 pi 是否报了 `Invalid models.json schema`（那会让**所有** provider 都不加载）；本仓写入的键都在 pi 允许集内，若你手改过请用备份回退后重跑 `install-provider` |
| 模型在列表里但请求失败 | 网关没起、端口不一致（看 `endpoint.json` 的实际端口与 `models.json` 的 `baseUrl`），或登录态过期、积分用尽、模型被冷却（`GET /healthz` 有 `cooldowns`） |
| 想只暴露部分模型 | `models set <id...>`（自动同步已安装的 provider）；`models all` 恢复全部 |
| `--api-key-env` 后 pi 看不到模型 | pi 只列“可用认证”的 provider；确认已设 `WORKBUDDY_GATEWAY_TOKEN`（且与 `serve` 同一值），再重启 pi |
| 模型列表太旧 | `status --catalog` 刷新后重跑 `install-provider` |
| 想看写入了什么 | 用 `--dry-run`，或直接 `git diff`/对比 `config-backups/` 里的备份 |

停止**你自己刚起的** `serve` 用 `Ctrl+C`/SIGTERM（优雅关闭，会删除 `endpoint.json`）。

> **清理纪律（重要）**：**任何清理/收尾都不得 `taskkill`/kill 任何 `pi-workbuddy-connect serve` 进程。**
> “父进程已退出”“创建时间落在本会话窗口”“命令行没有 `--auth-file`”**都不构成孤儿判据**：常驻网关的父进程本就可能已退出。
> 端口被占用只**报告**，不要杀进程。确需清理时**只删** pid 已死（`process.kill(pid,0)` 不可达）时残留的 `endpoint.json` **文件**，
> 该文件下次 `serve` 启动会自行清理；强杀产生的残留删文件即可，不要动进程。

### 已知限制 / Known limitations

- **CN 企业分支未验证**：`enterpriseId` 非空的 CN 账号走企业额度端点，代码与单测齐备但**无实机证据**。
- **国际版（WorkBuddy AI）与 RoW 变体未验证**：本机只装了国内版；`ai` 变体的 UA / 目录 / region 分支仅有代码路径。
- **ToS 风险**：本网关依赖**非官方私有接口**，使用可能违反上游条款，后果自负；默认低频、只读优先，出现风控请停用。
- **余额变化可能延迟，且受其它客户端影响**：小请求（24 token）前后余额未变；大请求实验已观测到下降（674→673→662，见 `docs/dev/S1-billing-experiment.md`）。因此「服务端按 token 扣费」的逐请求证据是上游返回的 `usage`（含 `credit` 字段），余额差值是**旁证**、且归因尚未收口。
- **端口默认 `8799`**：旧的 `8317` 曾被本机 `cli-proxy-api.exe`（EasyCLIProxyAPI）占用；现在默认 `8799`，且被占用时会**自动改挑空闲端口**并写入 `endpoint.json`。
- **冷却上限 2 小时**：来自外部观察，非本机实测。
- **`credits` 端点是本仓自造的便利端点**，不是上游或 OpenAI 标准的一部分。

## 凭据与安全 / Credentials and safety

- 桌面 App 的 auth 文件**永远只读**（本阶段运行不改变其 mtime）。
- 刷新后的 token 若写入，只写本仓自有目录：Windows `%APPDATA%\pi-workbuddy-connect\`，其它平台 XDG state home。POSIX 平台文件 `0600`、目录 `0700`；**Windows 无 POSIX mode**，`chmod` 是 no-op，副本仅与用户 profile 的继承 ACL 同私密性（本工具不承诺 0600），详见 [`docs/security.md`](./docs/security.md) §6。
- 解封密钥只在进程内存在，不落盘、不外发。
- 出站只允许三个上游域；本阶段只调用计费接口。
- 详见 [`docs/security.md`](./docs/security.md) 与 [`docs/compliance.md`](./docs/compliance.md)。

## 本次 S3 先导报告 / S3 pilot report

实现与实测证据（脱敏）见 [`docs/dev/S3-report.md`](./docs/dev/S3-report.md)；S2（接入 pi / subagent-win）见
[`docs/dev/S2-report.md`](./docs/dev/S2-report.md)。

## 开发 / Development

```bash
node --test        # 无网络单测；夹具自造，不读真实 token
```

```
bin/pi-workbuddy-connect.js     CLI 入口（status / doctor / serve / models / install-provider / uninstall-provider）
src/cli.js                      status / doctor / serve / provider 命令、参数解析、输出脱敏自检
src/serve.js                    网关装配：store + client + session + catalog + cooldown + server
src/provider/                   接入 pi：models.json 单成员字节级拼接（备份 / 幂等 / dry-run / 卸载）
src/provider/models-config.js   模型暴露策略（gateway.json.models；serve / install 共用）
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
