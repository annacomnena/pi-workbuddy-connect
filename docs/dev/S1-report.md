# S1 实现报告 — `pi-workbuddy-connect serve`（本地 OpenAI 兼容网关）

- 日期：2026-10-13
- 范围：**S1 网关本体**（`serve` 命令、四道闸、`/v1/*` 路由、凭据刷新、SF-6 加密副本、per-model 冷却）+ **一次已授权的真实推理实测**
- 基线：`HEAD = 531d77e`（S3 已入库）；本仓 `C:/Users/Annacomnena/pi-packages/pi-workbuddy-connect`，分支 `main`
- 规格：`~/wb-connect-study/research/20261013_wb_connect_plan.md`（§M5 / §1.3）、`..._research.md`（Q2/Q3、R1–R12、Do-NOT 13 条）、`docs/dev/S3-review.md`（SF-6 转入本阶段）
- **未 commit、未 push**；未动 `G:/code/**`、`subagent-win`、`~/.workbuddy`、桌面 auth 文件
- 本文件不含 token/账号明文；§8 明确标注哪些值是实测原值、哪些是按 SF-5 替换/扣留

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| `serve` 能否启动 | ✅ `node bin/pi-workbuddy-connect.js serve` 启动成功；`127.0.0.1:8317`（默认），地址/端口写入 `endpoint.json`（0600 请求；Windows 实为继承 ACL，文件不含密钥） |
| 只绑回环 | ✅ `netstat` 只见 `127.0.0.1:8317 LISTENING`；监听地址不可配置 |
| 四道闸是否实测 | ✅ 离线测试逐条反例：坏 Host→403、坏 Origin→403、无/错 Bearer→401、非 JSON content-type→415；`/healthz` 免 Bearer（只回状态） |
| 端点是否齐全 | ✅ `/healthz`、`/v1/models`（18 个真实模型，`workbuddy/<id>` + 分组/上下文/能力）、`/v1/chat/completions`（SSE + 非流式）、`/v1/workbuddy/credits`（标注非标准） |
| 真实推理是否成功 | ✅ **2 次**（≤2 上限）：非流式 HTTP 200 / 2.66 s / usage 13+2=15；流式 HTTP 200 / 2.24 s / 4 帧（3 chunk + `[DONE]`）/ usage 8+1=9 |
| 积分是否可见变化 | ❌ **未观察到**：`credits` 前后 `total` **完全相同**（数值按 SF-5 扣留）。可主张的是「**上游做服务端计量**」与「**本工具不做任何本地预扣/记账/余额闸门**」两类事实；**本会话无证据表明这 24 token 被扣费**（`credit:0` 更直接指向本次计 0 credit）。可能的解释见 §8.4 —— **（指针）该结论仅适用于 24 token 小请求；大请求实验见 `docs/dev/S1-billing-experiment.md`，已观测到余额下降** |
| 离线测试 | ✅ `node --test` **128/128 全绿**（无网络；网关测试只连 `127.0.0.1`，上游为注入假对象）；审查整改新增 7 个用例（其中 6 个 MF-1/SF-1 目标用例用注入缺陷方式自证可区分修复前后，见 §12） |
| SF-6 | ✅ 自留副本不再是明文：用**同一 at-rest key** AES-256-GCM 封存（实机验证 `containsPlaintextToken=false`、`roundTripOk=true`）；无 at-rest key 时走 OS 设施（DPAPI/Keychain/libsecret）；两者都无 → 显式降级 + 启动告警 |
| 未做项 | 企业分支 / 国际版未实机验证；余额变化未观测到（**（指针）后续大请求实验已观测到下降，归因待收口，见 `docs/dev/S1-billing-experiment.md`**）；`endpoint.json` 在 Windows 强杀后残留（见 §9） |

---

## 2. 改动清单

### 新增（`src/**`、`test/**`，全部未跟踪）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/protocol/body.js` | 146 | OpenAI → 上游 body 映射：强 `stream`、`tool_choice` 字符串化、`developer`→`system`、剥 `reasoning_effort:"off"`、国际版首条 system、`workbuddy/` 前缀 |
| `src/gateway/http.js` | 109 | 四道闸判定 + JSON 响应 + 64 MiB body 上限（`hostIsLoopback`/`originIsLoopback`/`isJsonContentType`/`readBody`） |
| `src/gateway/secret.js` | 132 | 32 B 随机密钥的生成/落盘/env 覆盖；`endpoint.json` 写/删/陈旧清理（均不含密钥） |
| `src/gateway/cooldown.js` | 129 | per-model 冷却表 + `Retry-After` / UTC+8 时刻解析 + 2 h 上限 |
| `src/gateway/openai.js` | 253 | OpenAI 模型列表、错误形状、`SseAccumulator`（SSE→`chat.completion` 折叠，含 tool_calls 合并）、`truncatedStreamFrame`（截断信令帧） |
| `src/gateway/catalog-cache.js` | 73 | 目录缓存（TTL）+ `snapshot()`（**不联网**，供 `/healthz`）+ live→saved→builtin 降级 |
| `src/gateway/server.js` | 486 | 路由、四道闸顺序、SSE 透传（含首帧前失败→502 与截断标记）、冷却映射、fail-closed 错误映射、`/healthz` 摘要 |
| `src/credentials/protection.js` | 266 | SF-6：`sealCredential`/`openCredential`（AES-256-GCM + 自有 AAD）、`createOsKeyStore`（DPAPI/Keychain/libsecret，可注入 runner） |
| `src/credentials/session.js` | 165 | `needsRefresh`/`applyRefresh`/`sessionStateOf` + 单飞刷新 + 失败退避 + fail-closed |
| `src/serve.js` | 192 | 装配层：store + client + session + catalog + cooldown + server；启动文档、告警与陈旧 endpoint 清理 |
| `test/protocol-body.test.js` | 120 | 映射逐条断言（含 `tool_choice` 四种形态、`none` 连带删 `tools`） |
| `test/cooldown.test.js` | 63 | 冷却解析、钳制、per-model 隔离、快照 |
| `test/protection.test.js` | 131 | 封存/解封/错 key/篡改；三种 OS 设施（假 runner）往返；无设施降级 |
| `test/session.test.js` | 167 | 刷新只写副本、单飞并发、失败退避、过期失败→`session-dead` |
| `test/gateway.test.js` | 569 | 四道闸反例、`/v1/models` 形态、SSE 帧序与截断信令（MF-1）、非流式折叠与中途失败（SF-1）、映射、429/402/401/502、credits |
| `test/serve.test.js` | 170 | `serve` 装配、密钥跨重启稳定 + env 覆盖、SF-6 降级告警、端点文件清理与陈旧 endpoint 判死（SF-5） |

### 修改

| 文件 | 关键落点 |
|---|---|
| `src/upstream/client.js` | 新增 `chatStream()`（SSE 不读 body、非 2xx 分类抛出）与 `refreshToken()`（`X-Refresh-Token` 唯一出现处）；`upstreamError` 的 `detail` 增 `bodyExcerpt`（仅进程内用于冷却/本地化消息，不落日志） |
| `src/upstream/headers.js` | `chatHeaders` 补 `Authorization: Bearer`（chat 请求此前缺该头） |
| `src/credentials/document.js` | 自留副本 **v2**：`protection`/`keySource`/`keyId`/密文；`readOwnDocument` 区分 v1 旧格式、v2 明文、v2 封存 |
| `src/credentials/store.js` | `readOwn` 改异步并接受 `openKey`；`writeOwn` 接受 `protector`；封存副本无法打开 → `credential-undecryptable`（不当作"无副本"） |
| `src/credentials/index.js` | `OwnCopyProtector`（先 at-rest key、再 OS 设施、再显式降级）；`readOwnCopy`/`writeOwnCopy` 异步；`current()` 不再把"副本打不开"吞成"未登录" |
| `src/config.js` | `--port` / `WORKBUDDY_GATEWAY_PORT` 解析与校验（默认 8317） |
| `src/cli.js` | `serve` 命令、`--port`、`runServe`（信号处理、优雅关闭）、`serve` 人类渲染，USAGE 更新 |
| `src/errors.js` | 新增 `invalid-request` / `gateway-forbidden` / `gateway-unauthorized` / `gateway-cooling` / `session-refresh-failed` 等原因码 |
| `test/credentials.test.js`、`test/cli.test.js` | 适配异步副本 API；新增 SF-6 封存/降级用例；新增 `serve` 子进程端到端（端点文件 + `/healthz` + 停止） |
| `README.md`、`docs/security.md`、`docs/protocol.md`、`.gitignore` | 见 §3–§6 |

---

## 3. 四道闸与安全设计

`createGateway`（`src/gateway/server.js`）在**服务任何路由 / 调用上游之前**按序执行，`/healthz` 只豁免第 3 条。精确顺序为 **Host → Origin → 路由匹配（未命中即 `404`）→ Bearer → 非 GET JSON → 方法**：即 404 路由匹配先于 Bearer（未授权者可区分路由是否存在，无数据暴露、不调上游）。

| # | 判定 | 失败 | 代码 |
|---|---|---|---|
| 1 | `Host` 去端口后必须是 `127.0.0.1` / `localhost` / `[::1]` | 403 `host_not_allowed` | `http.js#L30-46` |
| 2 | `Origin` 存在则必须回环（无 Origin 的非浏览器客户端放行） | 403 `origin_not_allowed` | `http.js#L49-58` |
| 3 | `Authorization: Bearer X` 与进程密钥 `timingSafeEqual`（先比长度） | 401 `invalid_api_key` | `server.js#L47-58` |
| 4 | 非 GET 必须 `Content-Type: application/json*` | 415 `unsupported_media_type` | `http.js#L61-64` |

- **密钥**：`randomBytes(32).toString('base64url')`（`secret.js#L19-60`），生成后写入自有目录 `gateway.json`；`WORKBUDDY_GATEWAY_TOKEN`（≥16 字符）优先且**不落盘**。密钥从不出现在日志、`endpoint.json`、`/healthz` 或错误体（唯一例外是第 3 条失败时提示"密钥在哪读"，不含值）。
- **绑定**：`server.listen(port, '127.0.0.1')`，硬编码，无 `--host`（`server.js#L449-458`）；实测 `netstat` 只有 `127.0.0.1:8317 LISTENING`。
- **`/healthz` 免 Bearer** 是**有意的**：它是就绪探针、只回状态/版本/掩码摘要/是否可解密/冷却状态，且**绝不触发上游请求**（用 `catalogSource.snapshot()` 只读 saved/builtin）。第 1、2 道闸仍然生效，所以 DNS rebinding 页面依旧进不来。
- **理由**（写进 `docs/security.md` §3）：`loopback bind is not a trust boundary`——本机任意进程与 rebinding 页面都能到达 `127.0.0.1`，故必须有第 1/2/3 道。
- 额外：64 MiB body 上限（超限 413）、上游流中断的**截断信令**（零字节已转发 → `502` + OpenAI 错误体；已转发部分帧 → 在 `data: [DONE]` 前补 `workbuddy_truncated` 帧，与非流式折叠标记一致）、每条答案记 `method/path/model/status/latency/stream`，**绝不记录 prompt / completion / 凭据**。

### 错误语义（fail-closed）

| 情形 | 响应 |
|---|---|
| 无本地凭据 | 401 `not_signed_in` |
| token 过期且刷新失败 | 401 `session_dead` |
| 上游 401 / `Offline user session not found` / `12153` | 401 `session_dead`，并在 `/healthz` 记 `credential.lastSessionDead` |
| 副本封存但密钥不可得 | 502 `credential-undecryptable`（不是"未登录"） |
| 上游 402 / 余额标记 | 402 `hard_credit`，不重试 |
| 上游 429 | 429 `soft_rate` + `Retry-After`，随后 per-model 冷却 |
| 上游不可达 / 5xx / 非 JSON | 502 |
| 上游 4xx | 400 |

---

## 4. SF-6：自留副本的存储保护与降级

自 S3 backlog 转入，本阶段闭合。副本格式 v2 记录所用保护：

| 序 | `protection` / `keySource` | 生效条件 |
|---|---|---|
| 1 | `aes-256-gcm` / `at-rest-key` | 能取到 App 自己的 at-rest key（**常规情形**：桌面凭据是加密信封，同一把 key 本来就要用它解封）。每次写入新 nonce；AAD 绑定本仓与格式版本（`pi-workbuddy-connect/own-copy/v2\0`） |
| 2 | `aes-256-gcm` / `os-dpapi` \| `os-keychain` \| `os-libsecret` | 取不到 at-rest key（明文桌面安装）：生成独立 32 B key 交给 **Windows DPAPI(CurrentUser)** / **macOS Keychain** / **Linux libsecret** |
| 3 | `plaintext` / `none` | **两者都不可用**——显式降级：启动日志打 `SF-6 DEGRADED: …`，`serve --json` 的 `warnings` 里列出，权限退化为 POSIX 0600 尽力 / Windows 继承 ACL |

fail-closed 规则（`store.js#L88-116`、`protection.js#L141-172`）：

- 封存副本的 key 取不到 → `credential-undecryptable`，**绝不**读成"无副本"；桌面文件也缺失时**绝不**静默降级。
- `keyId` 不匹配（at-rest key 轮换）→ 失败，不拿别的 key 试。
- OS helper 只调用固定系统工具（`powershell.exe -EncodedCommand`、`/usr/bin/security`、`/usr/bin/secret-tool`），固定参数表、10 s 超时、64 KiB 输出上限；密钥不外发。
- v1 旧格式仍可读（`legacy: true`），下次刷新自动升级为 v2。

**本机实机证据**（本地、离线，用**真 App at-rest key** 封存一个**夹具**凭据；脚本在 `%TEMP%`，跑完已删）：

```json
{
  "desktopFormat": "encrypted",
  "keySource": "at-rest-key",
  "protection": "aes-256-gcm",
  "fileBytes": 535,
  "containsPlaintextToken": false,
  "containsPlaintextRefresh": false,
  "declaresVersion": 2,
  "declaresProtection": "aes-256-gcm",
  "sealedHeaderKeys": ["authTag","ciphertext","keyId","keySource","nonce","protection","version"],
  "roundTripOk": true,
  "fileMode": "666"
}
```

`fileMode 666` 正是 Windows 无 POSIX mode 的实况（`chmod` 为 no-op，仅继承 ACL）——与 `docs/security.md` §6b 的表述一致，工具不承诺 0600。副本跑完已 `removeOwnCopy()` 删除。

---

## 5. 限流与退避（R4）

- **不做**本地预扣/记账/余额闸门：chat 路径不读余额（`docs/security.md` §3 与 `README` 计费节）。
- 上游 429 → `cooldowns.penalize(model, cooldownSecondsFrom({retryAfterSeconds, body, now}))`；402 → 默认冷却。
- `cooldownSecondsFrom` 优先级：`Retry-After`（秒/HTTP-date）→ 响应体里带 `cool|retry|expire|reset|until` 键的 UTC+8 时刻 → 默认 60 s；统一钳制到 **[1, 7200] s**（2 h 上限来自外部观察，非本机实测）。注（SF-8）：`Retry-After: 0` 或负数走**更保守的默认 60 s**，而非钳到下限 1 s——与 `[1,7200]` 的措辞差异仅为更保守，非缺陷，因此不改行为。
- 命中冷却的请求**立即** 429 + `Retry-After`，**不排队、不重试、不换账号/身份**；其他模型不受影响；`/healthz` 的 `cooldowns` 与错误体都能看到剩余秒数。
- 刷新失败也有退避（`REFRESH_FAILURE_BACKOFF_MS = 30 s`）防止"坏刷新端点 → 重试风暴"；旧 access token 仍有效（>30 s）则沿用并只记 warn。

---

## 6. 出站纪律

- 唯一出站模块仍是 `src/upstream/client.js`：新增的 `chatStream`/`refreshToken` 都经由 `this.url()` → `upstreamUrl()` 做 `UPSTREAM_HOSTS` 白名单前置校验，非法主机在发请求前抛错。
- 出站主机全集 = 3 个上游域（`copilot.tencent.com` / `www.codebuddy.cn` / `www.workbuddy.ai`），`serve --json` 的 `outbound.hosts` 明示。
- **零遥测**：无 telemetry/analytics/sentry/crash report；`serve --json` 里 `outbound.telemetry = "none"`。
- **UA 不伪造**：`WorkBuddy/5.7.7 WorkBuddy/5.7.7`，版本来自本机注册表（`resolveAppVersion`）；读不到时用**文档化且更低**的回退（cn 5.5.6 / global 5.5.2）并在启动告警，绝不编造更高版本、不追"最新版"（R3）。

---

## 7. 离线测试（真实输出）

```
$ timeout 300 node --test
# tests 128
# suites 0
# pass 128
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10999.6993
```

关键用例（可区分修复前后）：

- 四道闸反例：`gate 1: a non-loopback Host is refused with 403 …`、`gate 2 …Origin…`、`gate 3: a missing or wrong bearer is 401 …`、`gate 4: a non-JSON content type on POST is 415`；`/healthz needs no bearer but carries no credential material`。
- `/v1/models` 形态：`emits the OpenAI list shape with workbuddy/ ids and metadata`（id 前缀、`owned_by`、`group`、`context_window`、`max_output_tokens`、`capabilities`、`workbuddy_source`）。
- SSE 帧序（假上游）：`a streamed answer is forwarded as SSE frames in order, ending with [DONE]`（3 chunk + `[DONE]`，content-type `text/event-stream`）。
- 非流式折叠：`stream:false folds the upstream SSE into one chat.completion`（content 拼接、`finish_reason`、`usage`）。
- 映射：`the OpenAI body is mapped to the upstream wire shape`（`stream:true`、`tool_choice` 对象→字符串、`developer`→`system`、`reasoning_effort` 剥离、前缀剥离）。
- 429 冷却：`a 429 starts a per-model cooldown; other models keep working and /healthz shows it`（第二次请求不再打上游、`lastAnswer.type==='soft_rate'`）；`a 402 is a hard-credit failure and is never retried`。
- 刷新只写副本：`a due credential is refreshed once and the result goes only to the own copy`（store 无 `writeDesktop` 方法即证明）；`concurrent resolves share one refresh`；`a failed refresh keeps a still-valid access token and backs off`；`a failed refresh on an expired token fails closed as session-dead`。
- SF-6：`a sealed blob round-trips and rejects the wrong key or a damaged blob`；三种 OS 设施往返（假 runner，win32 断言脚本含 `ProtectedData]::Protect` + `CurrentUser`）；`a platform without an OS facility degrades explicitly`；`without any protection the copy degrades explicitly to plaintext`；`a sealed own copy is not readable when its key is unavailable`。
- `serve`：`serve starts, announces endpoint.json, answers /healthz without a bearer, and stops cleanly`（子进程 + 端点文件 + `/healthz`）；`the gateway secret is stable across restarts and env overrides it`；`a platform without protection and a plaintext desktop warns loudly (SF-6)`。

- 流式新增（MF-1）：`a stream that fails before its first frame is 502, not an empty 200 (MF-1)`、`a stream that fails mid-answer is marked workbuddy_truncated before [DONE] (MF-1)`、`a stream that ends without [DONE] is marked truncated (MF-1)`。
- 非流式新增（SF-1）：`a non-streaming fold that fails before any frame is 502, not 500 internal (SF-1)`、`a non-streaming fold that fails mid-answer keeps the partial answer, marked truncated (SF-1)`；`a truncated stream is marked instead of being reported as complete` 保留。

测试一律无外网：网关测试只连 `127.0.0.1` 并把上游换成注入的假对象（`test/gateway.test.js`）；`serve` 测试注入 `appVersion` 以免读注册表；夹具自造（`test/support/fixtures.js`），不读真实 token。

---

## 8. 一次已授权的真实推理实测（脱敏）

> **脱敏约定（SF-5）**：账号掩码（uid/uin 局部）、token 掩码、余额数值与套餐名**一律替换为占位或扣留**；
> 下表与示例里的**模型 id、token 计数、耗时、HTTP 状态、帧结构、字段名**为**实测原值**（非个人数据）。
> 全程**不含** token/账号明文。

### 8.1 过程

| 步骤 | 命令 | 结果 |
|---|---|---|
| 启动 | `node bin/pi-workbuddy-connect.js serve --port 8317` | ✅ 监听 `http://127.0.0.1:8317`；UA `WorkBuddy/5.7.7 WorkBuddy/5.7.7`（app version 5.7.7, `local-app`，未走回退） |
| 健康检查 | `GET /healthz`（无 Bearer） | ✅ HTTP 200：`credential.state=active`、`format=encrypted`、`decryptable=true`、`account.uidMasked=<redacted>`、`enterprise=false`、目录 `builtin`（snapshot 不联网） |
| 目录 | `GET /v1/models`（Bearer） | ✅ HTTP 200，`source=live`、**18** 个模型；`workbuddy/hy4-preview`(ctx 960000)、`workbuddy/hy3`(192000)、`workbuddy/deepseek-v4.1-flash`(1000000)、`workbuddy/glm-5.3`(1000000)… |
| 推理 #1 | `POST /v1/chat/completions` `stream:false`，`model=workbuddy/deepseek-v4.1-flash`，`max_tokens=16`，`temperature=0` | ✅ HTTP 200 / **2.66 s** |
| 推理 #2 | 同模型 `stream:true`，`max_tokens=16` | ✅ HTTP 200 / **2.24 s** |
| 余额 | `GET /v1/workbuddy/credits` ×2（推理前后各一次） | ✅ 两次 HTTP 200；`total` **前后完全相同**（**（指针）小请求、24 token；大请求对照见 `docs/dev/S1-billing-experiment.md`**） |
| 停止 | `taskkill /F`（见 §9 说明） | ✅ 端口释放，无残留进程 |

### 8.2 推理 #1（非流式）响应（实测，仅 id/掩码类值已替换）

```json
{"id":"chatcmpl-…","object":"chat.completion","created":<int>,"model":"workbuddy/deepseek-v4.1-flash",
 "choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":13,"completion_tokens":2,"total_tokens":15}}
```

- 请求 id：上游返回 `cmb-<32hex>`（值扣留）；网关响应 id 为本进程生成。
- 模型回显 = 客户端所请求的 `workbuddy/deepseek-v4.1-flash`（网关不改写客户端的 id 视图）。
- 结果与提示一致（`Reply with exactly the single word: pong` → `pong`）。

### 8.3 推理 #2（流式）帧序（实测）

```
frames: 4
  1 object=chat.completion.chunk  model=deepseek-v4.1-flash  delta={"role":"assistant","content":""…}  finish=null
  2 object=chat.completion.chunk  model=deepseek-v4.1-flash  delta={"content":"ok"…}                     finish=null
  3 object=chat.completion.chunk  model=deepseek-v4.1-flash  delta={…}                                  finish=stop  usage={"prompt_tokens":8,"completion_tokens":1,"total_tokens":9,…,"credit":0,…}
  4 [DONE]
--HTTP 200 total_time=2.245322s
```

- 上游 SSE 原样透传（帧序不变）；本次上游自带 `[DONE]`。截断信令：若上游在首帧前失败 → `502`；中途失败/无 `[DONE]` 结束 → 在 `[DONE]` 前补 `workbuddy_truncated` 帧（本次未触发，修正见 §12 MF-1）。
- 上游 usage 里带 **`credit`** 字段（本次为 **0**）与 `completion_thinking_tokens` 等——这说明**用量/计费由上游服务端计算**（本工具不参与，见下条），但 `credit:0` **不能**作为「这 24 token 被扣了积分」的证据，反而更直接地指向「本次请求计 0 credit」。

### 8.4 credits 前后对比（关键结论：未观察到减少）

> **（指针）本节结论已被 `docs/dev/S1-billing-experiment.md` 的大请求观测部分取代**：大请求后立即 −1、约 1.5–2 h 后 −12。本节原始实测值不改写，仅说明适用范围。

| 时点 | `total` | `unlimited` | 结构 |
|---|---|---|---|
| 推理前 | `<redacted>` | `false` | 4 个资源包（名称与 `remain`/`size` 数值扣留） |
| 推理后 | **与前完全相同** | `false` | 同上 |

结论：**15 + 9 = 24 token 的消耗在余额字段上不可观测**。可公开主张的只有两类事实：（**（指针）小请求、24 token；大请求见 `docs/dev/S1-billing-experiment.md`，已观测到下降**）
（a）本工具**不做任何本地预扣/记账/余额闸门**（chat 路径不调用计费接口，可 grep 证实）；
（b）上游对单次请求做**服务端计量**（§8.3 的 `usage` 由上游给出）。
但**本会话没有任何证据表明这 24 token 实际扣减了积分**——`credit:0` 更直接地指向「本次请求计 0 credit」。
「余额为何未变」的四种可能解释（当前证据无法取舍）：

1. **本次请求本就 0 费用**（`credit:0`；或该模型/该时段免费、首 N 次免费）——与观测最一致；
2. **结算延迟 / 批量结算**：`get-user-resource` 返回的是周期容量（`CycleCapacityRemain`/`CapacityRemain`），若结算异步聚合，则两次查询间隔内不可见；
3. **计量口径粗**：`total` 是整包剩余，24 token 的消耗低于显示/上报粒度；
4. **余额字段语义不同**：`total` 来自资源包 `remain`，可能不含按量计费部分。

> **（指针）后续实验补充第 5 条可能来源：其它客户端 / 桌面 App 同期消耗**（本机实测有多个 `WorkBuddy.exe` 进程在跑）；见 `docs/dev/S1-billing-experiment.md` §2 归因不干净一节。

要确立「按 token 扣费」需要一次**显式授权**的前后余额对照（加大 token 量到可观测粒度、并在结算窗口后复测），（**（指针）已启动**：见 `docs/dev/S1-billing-experiment.md` §3，需用户再授权 1 次）
或上游文档；本阶段证据不足。

### 8.5 启动文档（`serve --json`，本地、无推理）

```json
{"command":"serve","ok":true,"service":"pi-workbuddy-connect","url":"http://127.0.0.1:<port>","host":"127.0.0.1",
 "token":{"source":"config","path":"~\\AppData\\Roaming\\pi-workbuddy-connect\\gateway.json","value":"not printed"},
 "userAgent":"WorkBuddy/5.7.7 WorkBuddy/5.7.7","appVersion":{"value":"5.7.7","source":"local-app"},
 "credentialProtection":{"desktopFormat":"encrypted","atRestKeyExpected":true,"osFacility":"os-dpapi","protected":true},
 "outbound":{"hosts":["copilot.tencent.com","www.codebuddy.cn","www.workbuddy.ai"],"telemetry":"none"},
 "warnings":[],"redactionSelfCheck":{"ok":true,"patternsChecked":6}}
```

SF-6 未降级（`protected: true`）；`warnings` 为空（无 at-rest key 缺失、无版本回退）。

### 8.6 上游调用计数（诚实披露）

| 类型 | 次数 | 说明 |
|---|---|---|
| 推理（`POST /v2/chat/completions`） | **2** | 非流式 1 + 流式 1，均在 ≤2 上限内；无重试、无换身份 |
| 目录（`GET /v3/config`） | **1** | `/v1/models` 实时刷新（非推理；目录读） |
| 计费（`POST /v2/billing/meter/get-user-resource`） | **2** | credits 前/后对比（只读） |
| 刷新（`POST /v2/plugin/auth/token/refresh`） | **0** | token 有效期 27.7 天，未触发 |
| 本地 helper（Electron 取 at-rest key） | 1（serve 首解封）+ 1（SF-6 探针） | 均为本地只读 |

未出现 401/402/429 —— 因此**没有触发任何重试**，也没有"遇到 401/402/429 立即停止"的分支需要走。

---

## 9. 未做项与风险

1. **CN 企业分支未实机验证**：本机 `enterprise=false`，走个人计费端点；企业端点仅单测覆盖。
2. **国际版（`--variant ai`）/ RoW 未实机验证**：本机未装 WorkBuddy AI；global 的 UA / 目录 / 首条 system 分支只有代码与单测。
3. **余额变化未观测到**（§8.4）：无法用余额差值证明扣费；已如实记录，不粉饰。（**（指针）大请求实验已观测到下降，见 `docs/dev/S1-billing-experiment.md`；归因待收口**）
4. **Windows 优雅关闭**：`serve` 已注册 `SIGINT`/`SIGTERM` → `close()` 会删除 `endpoint.json`；但 Windows 上用 `taskkill /F`（或 git-bash `kill -INT`）**不会**触发该处理器，`endpoint.json` 会残留（本次实测已手动删除）。真实用户按 Ctrl+C 正常。已在 README 写明。
5. **`/healthz` 首次调用会解封凭据**（本地、只读，30 s 缓存）。若桌面凭据为加密且 App 二进制缺失，`/healthz` 报 `credential.state=error` 而非崩溃——符合 fail-closed。
6. **目录刷新 TTL 10 min**：`/v1/models` 在 TTL 内用缓存；`?refresh=1` 强制实时。上游改协议时按 live→saved→builtin 降级并标 `workbuddy_source`/`workbuddy_degraded_reason`（R2）。
7. **冷却是进程内状态**：重启后清空；上限 2 h 来自外部观察（非本机实测）。
8. **UA 的 CLI token 未加**：`CLI/<v>` 需要读 App 安装目录里的内置 CLI 版本，本阶段省略（文档化的行为是"缺版本就不写该 token"，而非编造）。
9. **文件域**：仅改本仓 `src/**`、`bin/**`（未改）、`test/**`、`README.md`、`docs/**`、`package.json`（未改）、`.gitignore`；新增 `docs/dev/S1-report.md`。

---

## 10. 仓库状态（原始输出）

```
$ git log -1 --format=%h
531d77e

$ git status --short
M .gitignore
 M README.md
 M docs/protocol.md
 M docs/security.md
 M src/cli.js
 M src/config.js
 M src/credentials/document.js
 M src/credentials/index.js
 M src/credentials/store.js
 M src/errors.js
 M src/upstream/client.js
 M src/upstream/headers.js
 M test/cli.test.js
 M test/credentials.test.js
?? docs/dev/S1-report.md
?? src/credentials/protection.js
?? src/credentials/session.js
?? src/gateway/
?? src/protocol/
?? src/serve.js
?? test/cooldown.test.js
?? test/gateway.test.js
?? test/protection.test.js
?? test/protocol-body.test.js
?? test/serve.test.js
?? test/session.test.js

$ git diff --stat
.gitignore                  |   4 ++
 README.md                   | 101 ++++++++++++++++++++++++++++--
 docs/protocol.md            |  22 ++++++-
 docs/security.md            |  71 ++++++++++++++++++---
 src/cli.js                  |  60 +++++++++++++++++-
 src/config.js               |  16 ++++-
 src/credentials/document.js |  82 +++++++++++++++++++++---
 src/credentials/index.js    | 148 ++++++++++++++++++++++++++++++++++++++++----
 src/credentials/store.js    | 117 +++++++++++++++++++++++++++++-----
 src/errors.js               |  10 +++
 src/upstream/client.js      | 107 +++++++++++++++++++++++++++++++-
 src/upstream/headers.js     |   3 +-
 test/cli.test.js            |  74 +++++++++++++++++++++-
 test/credentials.test.js    |  90 +++++++++++++++++++++++----
 14 files changed, 835 insertions(+), 70 deletions(-)
# 新增（未跟踪）另计：src 10 文件 1848 行 + test 6 文件 1089 行 + docs/dev/S1-report.md


仓库级泄露扫描（排除 `LEAK_PATTERNS` 定义、`docs/protocol.md` 字段名占位与测试向量）：
`eyJ…` / `Bearer <20+>` / `$wbEncrypted` / `"ciphertext"` **0 处真实值命中**；`git ls-files` 无 `*.info` 与凭据 json。

---

## 11. 纪律核对

- ✅ 未 commit、未 push；未动 `G:/code/**`、`subagent-win`、`~/.workbuddy`、桌面 auth 文件（mtime 仍为 `08:32`）。
- ✅ 未做多账号池 / 账号轮换 / 自动签到 / 绕限额 / 冷却期换身份；未写桌面 App 文件。
- ✅ 未向任何非上游域发送凭据；无遥测；唯一出站模块 + 白名单前置校验。
- ✅ 真实推理 **2 次**（≤2），无重试；测试全部无外网。
- ✅ 跑完无后台进程与端口（`netstat` 已确认 8317 释放；残留的 `endpoint.json` 已删除）。
- ✅ 报告/文档无 token 明文；账号相关值按 SF-5 扣留或替换为占位。

---

## 12. 审查整改（回应 L4 `docs/dev/S1-review.md`）

- 日期：2026-10-13（同批）
- 审查结论：PASS-WITH-CHANGES（暂不放行提交/推送）→ **本轮修完 2 条 must-fix + 8 条 should-fix（SF-1…SF-7 已落地，SF-8 仅文档）**；仍未 commit / 未 push。
- 纪律：**未发任何真实推理/上游请求**（授权的 1–2 次已在 §8 用完）；自测只用夹具凭据 + 临时 ownDir + 本地回环；未动其它仓、`~/.workbuddy`、桌面 auth 文件。

### 12.1 must-fix

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| **MF-1** 流式异常 → 200 + 空/截断且无信令 | ✅ 已修 | `src/gateway/server.js` `chat()` 流式分支；`src/gateway/openai.js` 新增 `truncatedStreamFrame()` | 改为**先 `await` 首个 chunk 再 `writeHead(200)`**：零字节已转发时上游报错 → `failAttempt` → **502 + OpenAI 错误体**；已有字节 → 在 `data: [DONE]` **之前**写 `data: {"error":{…,"type":"workbuddy_truncated"},"workbuddy_truncated":true}`；正常 `end` 但 `!sawDone` 同样补该帧。`lastAnswer.type` 在截断时为 `truncated` |
| **MF-2** 报告对「积分扣费」证据过度 | ✅ 已修 | `docs/dev/S1-report.md` §1 / §8.3 / §8.4 | 只主张「上游做**服务端计量**」「本工具**不做任何本地预扣/记账/余额闸门**」；明确「**本会话无证据表明这 24 token 被扣费**（`credit:0` 更直接指向本次计 0 credit）」；补入审查 §④ 的四种可能解释（0 费用 / 结算延迟 / 口径粗 / 字段语义不同），不改写 §8 的原始实测值 |

**MF-1/SF-1 用例自证可区分修复前后**（注入缺陷 → 红，还原 → 绿）：把 server.js 流式分支改回「先 writeHead 200 + pipe + 只补 `[DONE]`」、非流式分支改回「让异常冒泡到顶层 → 500」，`node --test test/gateway.test.js` 得 **`# tests 24 / pass 18 / fail 6`**，失败的正是 6 个目标用例（`MF-1` ×3、`SF-1` ×2、原有非流式 truncated ×1）；还原后 **`# pass 24 / fail 0`**。

### 12.2 should-fix

| 项 | 状态 | 落点 | 说明 |
|---|---|---|---|
| **SF-1** 非流式中途报错 → 500 `internal` | ✅ 已修 | `server.js` 非流式折叠段 | 二选一取「**返回部分 completion + `workbuddy_truncated:true`（HTTP 200）**」：保留客户端已收到的部分答案，且与流式路径的截断语义一致；仅当**异常且零有效帧**（`rawChunks===0`）时改为 `failAttempt` → 502（与 MF-1 零字节一致）。测试锁住 502 与 partial+truncated 两态 |
| **SF-2** 「在路由之前」措辞不精确 | ✅ 已修（改措辞） | `docs/security.md` §3、`docs/protocol.md` §6、`README.md`、本报告 §3 | 改为「**在路由分发/上游调用之前**」，并明示精确顺序 Host → Origin → **路由匹配（未命中即 404）** → Bearer → 非 GET JSON → 方法；说明未授权者可区分路由存在性、无数据暴露。**未改行为**（避免行为变更） |
| **SF-3** 运行时 SF-6 降级静默 | ✅ 已修 | `src/credentials/index.js` `OwnCopyProtector.seal()`；`src/serve.js` 向 `CredentialStore` 传 `logger` | `seal()` 回落到 `plaintext` 时 `logger.warn('SF-6 DEGRADED at runtime: …')` 一次（含原因与影响，实例内去重）。测试：`test/credentials.test.js` 断言该 warn 出现且重复写入不再重复告警 |
| **SF-4** 企业计费 URL 绕过白名单助手 | ✅ 已修 | `src/billing/index.js` | `ENTERPRISE_URL` 常量改为 `ENTERPRISE_PATH`，两条计费路径统一走 `client.url(billingBaseFor(credential), path)`；测试断言 `client.url` 收到 `/v2/billing/meter/get-enterprise-user-usage` |
| **SF-5** 真实 own dir 残留陈旧 `endpoint.json` | ✅ 已修 | `src/gateway/secret.js` 新增 `removeStaleEndpointFile()`；`src/serve.js` 启动时调用并日志 | 以 `process.kill(pid, 0)` 判活（EPERM 视为存活）；死 pid / 坏 JSON → 删除。**已删除真实 own dir 的陈旧 `endpoint.json`**（pid 760752 已死；仅该文件，未动 `gateway.json` / 目录的 catalog）。单测 + 本地自测第二轮启动实测日志 `removed a stale endpoint.json …` |
| **SF-6** `protocol.md` 「usage exactly as upstream」不准 | ✅ 已修 | `docs/protocol.md` §6 | 改为「流式原样透传（含 `credit` 等子字段）；非流式归一为 `prompt_tokens`/`completion_tokens`/`total_tokens`，丢 `credit`/`completion_thinking_tokens`」 |
| **SF-7** `/healthz` 无鉴权暴露掩码元数据 | ✅ 已修（文档） | `docs/protocol.md` §6、`docs/security.md` §3、`README.md` | `/healthz` 段补「**本机任意进程可读（无鉴权）**」，并保持最小化 |
| **SF-8** `Retry-After: 0` → 60 s 与 `[1,7200]` 措辞 | ✅ 仅文档说明，未改行为 | 本报告 §5 | 明示 `Retry-After: 0`/负数走更保守的默认 60 s（非钳到 1 s），差异仅更保守、非缺陷 |

### 12.3 真实输出（本轮）

```
$ timeout 300 node --test
# tests 128
# suites 0
# pass 128
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10999.6993
```

注入缺陷自证（`test/gateway.test.js`）：`# tests 24 / pass 18 / fail 6`（失败集 = MF-1×3 + SF-1×2 + 非流式 truncated×1）；还原后 `# tests 24 / pass 24 / fail 0`。

零上游请求本地自测（真实 `serve` 子进程 + 夹具凭据 + 临时 ownDir，只打 `/healthz` 与必然被闸拒绝的路径；外层 `timeout`）：

```
200    GET /healthz (no bearer)            pi-workbuddy-connect
401    GET /v1/models (no bearer)           invalid_api_key
404    GET /v1/nope (no bearer)             not_found
401    GET /v1/models (bad bearer)          invalid_api_key
403    GET /v1/models (bad Host)            host_not_allowed
405    GET /v1/chat/completions (bearer)    method_not_allowed
415    POST /v1/chat/completions (bad c/t)  unsupported_media_type
credential token leaked: false
endpoint.json left after hard kill: true
startup removed stale endpoint: true
second port freed: true
```

与审查 §1 的状态码表一致（无回归）；`taskkill`/SIGTERM 硬杀后残留的 `endpoint.json` 在下次启动被清理（SF-5 集成证据）。跑完临时目录已删、无监听端口、无遗留 `serve` 进程。

### 12.4 未做项与理由

- **无功能未做项**：2 条 must-fix 与 SF-1…SF-7 全部落地；SF-8 按审查要求**只改文档不改行为**。
- **不顺带做的审查附带建议**：① Bearer 长度短路的侧信道加固（改为比较 SHA-256/HMAC）——审查自评「可选加固，非缺陷」，本轮不动；② 把 404 移到 Bearer 之后——优先改措辞以免行为变更（SF-2）；③ Windows 优雅关闭：SIGTERM/`taskkill /F` 不触发 JS 信号处理器属 Node/Windows 行为，已由 SF-5 的启动清理缓解，不引入新信号机制。
- **不重跑真实上游**：报告 §8 的推理次数 / `credits` 前后 / 流式末帧 `credit` 等需真实上游请求，本轮硬约束禁止，维持审查「无法独立验证」的标注。

