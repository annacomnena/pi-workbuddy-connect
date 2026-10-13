# S1 独立审查（L4 · 另起进程 · 只读 · 对抗式）

- 日期：2026-10-13
- 被审对象：`pi-workbuddy-connect` 未提交工作区 = **S1 反代本体**（`src/gateway/**`、`src/protocol/**`、`src/serve.js`、`src/credentials/{protection,session}.js` + 8 处修改 + 6 个新测试）；`HEAD=531d77e`，分支 `main`
- 被审报告：`docs/dev/S1-report.md`（**不采信自述**）
- 规格基准：`~/wb-connect-study/research/20261013_wb_connect_plan.md`（§M5 / §1.3）、`..._research.md`（Q2/Q3、R1–R12、Do-NOT 13 条）、`docs/dev/S3-review.md`（SF-6 转入）
- 上游参照（只读，MIT）：`~/wb-connect-study/package/lib/index.js`
- 方法：静态对照 + **自起本地 `serve` 打本地端口**（夹具凭据 / 临时 ownDir，**未携带合法 Bearer 触发 `/v1/models`、`/v1/chat/completions`、`/v1/workbuddy/credits` 等需要上游的路径**）+ 独立模块级夹具（body 映射 / SSE 折叠 / 冷却 / 封存 / 会话）+ 纪律核对；**全程零上游请求、零遥测、零 commit/push**
- 本文件不含任何 token / 账号明文；掩码仅以占位描述

---

## ① 总判定

**PASS-WITH-CHANGES（暂不放行提交/推送）** —— 四道闸、鉴权、SF-6 封存、刷新语义、退出纪律与报告的**结构性事实**全部独立复现成立；但有 **2 条 must-fix**：① 流式路径存在「上游异常 → 200 + 空/截断回复」且无截断标记；② 报告 §1/§8.3 对「积分扣费」的证据主张不成立（`credit:0` 不能证明本次请求被扣费）。

---

## ② 逐条复核（判定 + 我跑出的证据）

### 1. 四道闸：顺序、覆盖面、`/healthz` 豁免 —— 判定：PASS（附 1 条 should-fix）

**自起 `serve --port 18317`（夹具明文凭据 + 临时 ownDir，env `APPDATA` 指向 `%TEMP%`）实测状态码：**

| 探测 | 实测 | 期望 | 结论 |
|---|---|---|---|
| `GET /healthz`（无 Bearer） | **200** | 200 | ✓ 只豁免第 3 条 |
| 裸 socket 无 `Host` | **400**（Node HTTP 解析器拒绝，未进 handler） | fail-closed | ✓ 无 Host 不可达路由 |
| `Host: evil.example` | **403** `host_not_allowed` | 403 | ✓ |
| `Origin: https://evil.example` | **403** `origin_not_allowed` | 403 | ✓ |
| 无 Bearer | **401** `invalid_api_key` | 401 | ✓ |
| 错 Bearer | **401** `invalid_api_key` | 401 | ✓ |
| 错长度 Bearer | **401** `invalid_api_key` | 401 | ✓ |
| 合法 Bearer + `Content-Type: text/plain` 的 POST | **415** `unsupported_media_type` | 415 | ✓ |
| 合法 Bearer + `GET /v1/chat/completions` | **405** `method_not_allowed` + `Allow: POST` | 405 | ✓ |

**判定顺序（组合探测，均与代码一致）：**

| 组合 | 实测 | 说明 |
|---|---|---|
| 错 Bearer + 坏 content-type | **401** | 第 3 道（Bearer）先于第 4 道（content-type） |
| 坏 Origin + 无 Bearer | **403** `origin_not_allowed` | 第 2 道先于第 3 道 |
| 坏 Host + 坏 Origin + 无 Bearer | **403** `host_not_allowed` | 第 1 道最先 |
| 合法 Bearer + 坏 Origin | **403** `origin_not_allowed` | Origin 先于 Bearer |
| `/healthz` + 坏 Origin / 坏 Host | **403** | `/healthz` 只豁免 Bearer，闸 1/2 仍生效 |

代码顺序（`src/gateway/server.js:369-408`）与实测一致：**Host → Origin →（路由匹配）→ Bearer → 非 GET JSON → 方法**。绑定为 `server.listen(port, '127.0.0.1')`（`:449`），无 `--host`；`netstat` 只见 `127.0.0.1:18317 LISTENING`。

**should-fix（SF-2）**：**路由匹配（404）发生在 Bearer 之前**——`GET /v1/nope`（无 Bearer）实测 **404 `not_found`**，而非 401。因此 `docs/security.md` §3、`docs/protocol.md` §6、报告 §3 的「四道闸在**路由之前**」表述不精确（应为「在**路由分发/上游调用之前**」）。未授权调用者可区分「存在/不存在」的路由；无数据暴露，非安全边界问题。

**`/healthz` 免 Bearer 是否正确**：**正确但需说明边界**。`/healthz` 调 `catalogSource.snapshot()`（`network:false`，只读 saved/builtin）+ `session.peek()`（**不触发刷新**），代码路径可达面内**零上游请求**（我逐行核对 `server.js:117-155`、`catalog-cache.js:53-58`、`session.js:139-150`）。它返回：版本/绑定/`tokenSource`、**掩码**账号（uid 3+2、uin 3+2、token 4+4）、会话到期、目录来源与计数、冷却表、`lastAnswer`（模型/状态/耗时）。**不含任何明文凭据**（实测 `healthz contains token: false`、`contains fixture access token: false`）。因回环绑定不是信任边界，本机任意进程可读取这些**掩码/元数据**——可接受（就绪探针），建议（SF-7）文档明示并保持最小化。

### 2. 鉴权实现 —— 判定：PASS

- **生成**：`randomBytes(32).toString('base64url')`（`secret.js:55`）。实测 token **43 字符、纯 `[A-Za-z0-9_-]`**。
- **落盘**：`%APPDATA%\pi-workbuddy-connect\gateway.json`，`mode: 0o600`（`:60`）；**Windows 实测 mode=666**（继承 ACL）——与 `docs/security.md`、README 表述一致（工具不承诺 0600）。
- **env 覆盖优先级**：`WORKBUDDY_GATEWAY_TOKEN`（≥16 字符，否则抛错）**优先且不落盘**（`loadOrCreateToken:41-46`）；实测 `tokenSource=env` 时旧 config 密钥被拒（`serve.test.js` 用例 + 我复核代码）。present-but-corrupt config **不静默替换**（抛错，`:47-53`）。
- **比较**：`timingSafeEqual`（`server.js:50`），**先比长度**。前缀用 `tail -n` 明确标注「length check before the compare」。注：长度短路对**定长随机密钥**不泄露内容（长度本身公开），符合通行做法；如需消除长度侧信道可改为比较两串 SHA-256/HMAC（可选加固，非缺陷）。
- **密钥泄露面（逐项实测，全部 false）**：`/healthz` body、401 错误体、`endpoint.json`、serve 启动日志 —— **均不含 token**；401 文案只提示「密钥在 gateway config / env」，不含值。日志调用点（`server.js:307,321,332,343,346,394`）只记 `model/status/type/ms/stream`，**不记 prompt/completion/凭据**。
- **唯一残留风险（沿用 S3 R6，文档已披露）**：`gateway.json` 在 Windows 上实际权限为继承 ACL，同机其它用户可能可读该 bearer。非本阶段新引入。

### 3. 请求体映射（`src/protocol/body.js`）—— 判定：PASS

**自造边界用例（独立脚本，37 项，全 PASS）：**

| 用例 | 结果 |
|---|---|
| 缺 `stream` / `stream:false` | 强置 `stream:true` ✓ |
| `workbuddy/` 前缀（大小写混合、带空白）/ 无前缀 | 剥离 ✓ |
| 多余字段 `top_p/metadata/stop/n/seed` | **原样保留** ✓ |
| 图片内容块 `image_url`（data URI） | **原样透传** ✓ |
| `tools`+`tool_choice:"none"` | 删 `tool_choice` **并**删 `tools`/`functions` ✓ |
| `tool_choice`: `{auto}/{required}/{function:{name}}/{function,name}/{function:{}}/未知对象/数字` | `auto/required/name/name/auto/删除/删除` ✓ |
| `reasoning_effort:"off"` / `"high"` / `"OFF"` | 删 / 留 / **留（大小写敏感）** ✓（上游 quirk 即精确 `"off"`） |
| `developer` → `system`（多轮全部） | ✓ |
| global 首条 system：非 system 才前置、已是 system 不合并；cn 不前置 | ✓ |
| `parseChatRequest`：非 JSON / 数组 / 标量 / 缺 `model` / 空 `messages` / 缺 `model` | 全拒绝 ✓ |

与上游契约（研究 E9：强 `stream`、`tool_choice` 字符串、`developer`→`system`、国际首条 system、剥 `reasoning_effort:"off"`）逐条一致。

### 4. SSE 与折叠 —— 判定：PASS-WITH-CHANGES（1 条 must-fix）

- **逐帧透传（不缓冲整包）**：自造上游「首帧 → 等 700ms → 次帧 → `[DONE]`」。**首帧到达延迟 7ms**，流总时长 ≥700ms，3 帧按序到达 → **确为增量转发，非整包缓冲** ✓（`server.js:314-328`：`Readable.fromWeb(result.stream)` + `upstream.pipe(res)`）。
- **`[DONE]` 语义**：上游自带 `[DONE]` → **不重复**（实测 count=1）✓；无 `[DONE]` 结束 → 网关补一条 ✓。
- **非流式折叠**：`tool_calls` **跨帧合并**（`id` 一次、`name`/`arguments` 拼接）（自造 3 帧 → `{"name":"get_weather","arguments":"{\"city\":\"X\"}"}`）✓；`usage` **末帧覆盖**且仅保留 `prompt/completion/total`（`credit` 等**不注入**）✓；空 content → `null` ✓；`reasoning_content` 透传 ✓；无 `[DONE]` → `workbuddy_truncated:true` ✓；多 choice 按 index 排序 ✓；坏 JSON 帧跳过不致命 ✓。
- **must-fix（MF-1）异常中途断流的错误形状**：
  - *有延迟的多帧后报错*：客户端收到**已转发的部分帧 + `[DONE]`**，HTTP **200**（可接受，因 200 头已发）。
  - *首个 queued 帧后立即报错（无延迟）*：客户端只收到 **`data: [DONE]`**，HTTP **200** —— **上游已送出的首帧被丢弃**，客户端得到一个「成功但空」的回复。
  - *流式路径完全无截断标记*：非流式折叠会打 `workbuddy_truncated`，流式路径**从不标记**，`[DONE]` 会被 OpenAI 客户端读作「正常完成」。→ 存在「异常 → 200/空回复且不可区分」的路径。
  - 注：plan §M5 只要求「断流补 `data: [DONE]`」，本实现符合该字面要求；但**缺失截断信令**是正确性缺口。

### 5. fail-closed 与错误映射 —— 判定：PASS（附 2 条 should-fix）

**注入式实测（`createGateway` + 受控 session/client，无网络）：**

| 触发 | 实测响应 | 结论 |
|---|---|---|
| session 抛 `credential-undecryptable` | **502** | ✓ 不读成「未登录」 |
| session 抛 `credential-unreadable` | **502** | ✓ |
| session 抛 `session-dead` | **401** | ✓ |
| session 抛 `credential-missing` | **401** | ✓（`not_signed_in`） |
| `/healthz` 遇不可解密副本 | 200 + `credential.state:"error"` + `reasonCode:"credential-undecryptable"` | ✓ 不静默 ok |

- 上游类映射（已复核代码 + 单测）：402→402 `hard_credit`（不重试）、429→429 `soft_rate`+`Retry-After`、401/`Offline user session not found`/`12153`→401 `session_dead`、404/5xx/不可达/非 JSON→502、其它 4xx→400；`sessionDead` 写入 `/healthz.credential.lastSessionDead` ✓。
- **fail-closed 成立**：`readOwn` 封存但 key 不可得 → `credential-undecryptable`；`CredentialStore.current()` 在无桌面文件时若 `lastOwnCopyError` 存在则**抛出而非返回 undefined**（`index.js:334-339`）✓；`keyId` 不匹配 → 失败（不试别的 key）✓。
- **「异常 → 200/空回复」**：除 MF-1 的流式路径外，**存在一处**——非流式折叠时上游流中途报错，`for await` 抛出 → 顶层 catch → **500 `internal`**（丢弃已收部分、未走 502 映射）。（SF-1）

### 6. 冷却（R4）—— 判定：PASS

- **per-model 隔离**：`penalize('a')` 不影响 `b`；`snapshot()` 只列活动项；命中冷却的请求由 `server.js:210-220` **立即** 429+`Retry-After`，**不打上游**（单测 `client.calls.length===1`）✓。
- **`Retry-After` 解析**：秒数与 HTTP-date 两形态（`client.js:145-153`）✓；HTTP-date 以 `Date.now()` 现算（非注入 now，仅测试计时差异）。
- **UTC+8 时刻解析**：`YYYY-MM-DD HH:MM:SS` / `T` 无时区 → 视为 `+08:00`（`cooldown.js:26-34`，自造 `09:30:00`→ `01:30Z` 断言通过）✓；带时区 ISO 原样解析 ✓；坏串忽略 ✓。
- **2h 钳制**：`clampCooldown` → `[1,7200]`；远端 UTC+8 时刻 → 7200（自造断言通过）✓。注：`Retry-After: 0` 走「≤0 → 默认 60s」（非 1s），**保守**，与「clamp [1,7200]」文字略有出入（SF-8，非缺陷）。
- **无换身份/重试风暴**：`UpstreamClient` **无任何 retry/attempt/sleep 循环**（全仓 grep 仅注释）；无账号池/轮换（`pool|selectAccount|rotate|checkin|签到` 仅出现在 `DO_NOT` 文案）；会话层失败有 `REFRESH_FAILURE_BACKOFF_MS=30s` 退避 ✓。
- **冷却反映到 `/healthz`**：`cooldowns: { model: remainingSeconds }` ✓（单测 + 代码）。

### 7. SF-6 存储保护 —— 判定：PASS（附 1 条 should-fix）

**自造夹具（独立于仓内测试）实测：**

| 场景 | 结果 |
|---|---|
| 正确 key 往返 | ✓ |
| 错 key（另 32B） | `undefined`（失败）✓ |
| 篡改 ciphertext / authTag / nonce | 全 `undefined` ✓ |
| **异 AAD 封存的密文**（我手工造） | 本仓固定 AAD 打不开 ✓ |
| 封存后文件是否含明文 | `false`（access/refresh token 均不出现）✓ |
| 文件头字段 | `version,protection,keySource,keyId,nonce,authTag,ciphertext` ✓ |

- **AES-256-GCM 参数**：key 32B、nonce 12B、tag 16B（`protection.js:34-36,69-77`）；**自有 AAD** `pi-workbuddy-connect/own-copy/v2\0`（`:27`，实测常量吻合）✓。
- **密钥来源链**：① App at-rest key → ② OS 设施（win32 DPAPI CurrentUser / darwin Keychain / linux libsecret）→ ③ 显式降级。**端到端实测**：注入假 helper 的 at-rest key → 封存副本 `keySource=at-rest-key`、文件无明文、往返成功；无 at-rest key 且无 OS 设施 → `protection=plaintext,keySource=none,degraded.reason=no-protection-available`。
- **降级是否真的在启动时告警**：**是**。我自起 `startServe`（`plat:'freebsd'` + 明文桌面）→ logger 实收 `SF-6 DEGRADED: …`，`credentialProtection={protected:false,osFacility:null}`。代码 `serve.js:100-105` 与 `serve --json` 的 `warnings` 均含该条 ✓。
- **副本不含明文 token**：`harness4` A 实读封存副本 → `containsPlaintextToken=false` ✓。
- **失败时必须失败**：错 key/篡改密文 → `openCredential` 返回 `undefined`；`readOwn` 封存副本 key 不可得 → `credential-undecryptable`（**不当作「无副本」**）✓。

**should-fix（SF-3）运行时静默降级**：启动告警只覆盖「启动时预测两者皆无」。若启动时 OS 设施**存在**（`protected:true`）但**写入时失败**，`OwnCopyProtector.seal()` 会静默回落 `plaintext`（仅记 `store.lastProtection.degraded`），**无任何日志/告警**——与「There is no silent downgrade」的措辞存在落差。最小修法：`seal()` 返回 `degraded` 时 `logger.warn` 一次。

### 8. 刷新语义 —— 判定：PASS

- **只写自有副本**：`store` 结构上**没有** `writeDesktop` 之类方法；`session.refresh()` 只调 `store.writeOwnCopy`（`session.js:94`）；全仓写调用点仅 ownPath / ownDir / savedCatalog / gateway.json / endpoint.json / own-copy.key（grep 穷举）。**桌面 auth 文件 mtime 全程 `08:32`、size 7912 不变** ✓。
- **单飞并发**：自造 3 路并发 `resolve()` → `refreshToken` 调用 **1 次**、`writeOwnCopy` **1 次** ✓。
- **失败退避**：refresh 抛错且旧 token 仍 >30s 有效 → 沿用旧 token、`refreshed:false`；第二次 resolve `refreshSkipped:true`、**不再打刷新** ✓。
- **过期失败 → `session-dead`**：token 已过期（-60s）且 refresh 失败 → `WbError(session-dead)` ✓（fail-closed）。
- **`X-Refresh-Token` 只出现在刷新路径**：生产代码中仅 `refreshHeaders()`（`headers.js:83`）；`chatHeaders` 不含；`redact.js` 另有该头的脱敏正则 ✓。

### 9. 报告诚实性 —— 判定：PASS-WITH-CHANGES（1 条 must-fix）

**与代码/报告一致的部分（可独立复核）：**
- 新增/修改文件清单、行数与 `git status` **逐字一致**（14 改 + 6 新测试 + `docs/dev/S1-report.md`；`server.js 432 行`、`openai.js 241`、`protection.js 266`、`session.js 165`、`serve.js 187` 等均与 `wc -l` 相符）。
- 「新增 6 个测试文件」✓；我亲跑 `node --test`：**121/121 全绿、4.77s**（无网络特征）。
- 「`/healthz` 免 Bearer、只回状态/掩码」✓（实测）；「密钥不落 `endpoint.json`」✓；「Windows `taskkill` 残留 `endpoint.json`」✓（我 SIGKILL 后实测残留）。
- 报告 §8.6 的动作计数（推理 2 / 目录 1 / 计费 2 / 刷新 0）与 §8.1 流程自洽；`needsRefresh` 的 5 分钟边距也支持「token 有效 27.7 天 → 刷新 0」。

**无法独立验证（我按硬约束拒绝重跑）：** 推理次数、`credits` 前后 `total` 相同、流式末帧 `credit` 值 —— 均需真实上游请求。（**（指针）后续大请求实验见 `docs/dev/S1-billing-experiment.md`，已观测到余额下降**）

**must-fix（MF-2）「积分扣费」证据主张不成立：** 报告 §8.3 称「上游 usage 里带 `credit` 字段（**本次为 0**）……即**计费/用量由服务端计算**的直接证据」，§1 亦称「服务端按 token 计费的证据是上游 `usage`（流式末帧带 `credit` 字段）」。但**该帧的 `credit` 值为 0**：`credit:0` 恰恰与「本次请求消耗 0 积分」同样相容，**不能**证明这 24 token 被扣费。报告把它写成「扣费的直接证据」属**过度归因**。最小修法：改述为「上游返回了带 `credit` 子字段的 per-request `usage`，说明**用量/计费由服务端计算**；本会话**没有任何证据**表明这 24 token 实际扣减了积分」。

（诚实性加分项：报告**主动披露**了 `credit:0`、余额未变、以及「余额变化未观测到」，未见粉饰；问题仅在这一句因果措辞。）

### 10. 范围 / 纪律 —— 判定：PASS（附 1 条 hygiene 观察）

- **`git status` 只动本仓**（14 改 + 6 新测试 + 报告，与开始时逐字一致；我未改任何仓内既有文件）。
- **无 commit / push**：`HEAD=531d77e`（S3，14:30），reflog 最近提交均早于 S1 工作；`main` 未推进。
- **未触碰其它仓**：`subagent-win` 工作区干净（`38f901f`）；`G:/code` 存在但代码零引用；**桌面 auth 文件 mtime 不变（08:32:33）**；`~/.workbuddy` 在代码中**零引用**（其 15:01 mtime 来自运行中的 `WorkBuddy.exe`，非本工具）。
- **无遥测 / 无域外联**：全仓无 telemetry/analytics/sentry/crash；`src/` 内 URL 仅 3 个上游域 + 回环（`UPSTREAM_HOSTS` 前置白名单 `upstreamUrl()`）；`serve --json.outbound.telemetry="none"`。出站调用点穷举 = `client.js` 的 `send/chatStream/refreshToken`（3 处），`fetch` 无其它调用者。
- **无残留进程/端口**：我起的 18317 已释放、无监听；`netstat` 无 8317/8318 监听；我全部夹具临时目录已删。
- **hygiene 观察（SF-5）**：真实 own dir `%APPDATA%\pi-workbuddy-connect\` 存在**陈旧 `endpoint.json`**（port 8318、pid 760752、`startedAt 15:00:24` —— **晚于**报告 mtime 14:59），pid **已死**、端口未监听、**不含密钥**。报告 §9.4 称「本次实测已手动删除」，与当前残留不符（应为报告定稿后又跑过一次 serve 未清理）。建议删除并让 `serve` 启动时清理同目录旧 endpoint（或写 pid 并检测存活）。

---

## ③ must-fix / should-fix

### must-fix（2）

- **MF-1 流式路径：上游异常 → 200 + 空/截断回复且无截断信令**
  `server.js:313-329` 先 `writeHead(200, SSE)` 再 `pipe`；`upstream.on('error')` 只补 `data: [DONE]`，不标记截断。实测：上游在**首帧入队后立即报错**时，客户端只收到 `data: [DONE]`（HTTP 200）——一个「成功但空」的回复；多帧后报错则部分帧 + `[DONE]`，同样**不可区分于完整回复**（非流式折叠有 `workbuddy_truncated`，流式没有）。
  **最小修法**：在 `writeHead` 前先 `await` 拿到首个 chunk（或计数已转发字节）；`error` 且**零字节已转发** → 回 502 + OpenAI 错误体；已有字节转发 → 在 `upstream.on('error')` 里先写一条 `data: {"error":{...},"workbuddy_truncated":true}` 再写 `data: [DONE]`，并在正常 `end` 但 `!sawDone` 时**同样**加 `workbuddy_truncated` 标记。

- **MF-2 报告 §1/§8.3 的「积分扣费」证据主张过度**
  以 `credit:0` 的 `usage` 字段作为「服务端按 token 计费」的直接证据不成立。
  **最小修法**：按上文 §9 改述（只主张「上游做服务端计量」；明确「本会话无证据表明这 24 token 被扣费」）。

### should-fix

- **SF-1 非流式折叠遇上游中途报错 → 顶层 catch 变成 500 `internal`**（`server.js:392-396`），丢弃部分答案且未走 502 映射。最小修法：在 `for await` 外加 try/catch，映射为 502，或返回部分 completion + `workbuddy_truncated:true`。
- **SF-2 404 路由匹配先于 Bearer**：修正 `docs/security.md` §3 / `docs/protocol.md` §6 / 报告 §3 的「在路由之前」措辞（或把 404 移到 Bearer 之后）。
- **SF-3 运行时 SF-6 降级静默**：`OwnCopyProtector.seal()` 返回 `degraded` 时无日志。最小修法：`writeOwnCopy`/`seal` 处 `logger.warn`。
- **SF-4 企业计费 URL 绕过白名单助手**：`billing/index.js:33` 硬编码 `https://www.codebuddy.cn/...` 直接传入 `client.send`。虽属 3 个允许域之一，建议改走 `client.url(billingBaseFor(...), path)`。
- **SF-5 真实 own dir 残留陈旧 `endpoint.json`**：删除；并考虑启动时清理同目录旧 endpoint（pid 存活检测）。
- **SF-6 `docs/protocol.md` 称「forwards `usage` exactly as the upstream reported it」不准确**：流式路径是原样透传，非流式折叠会把 `usage` 归一到 `prompt/completion/total`（丢 `credit`/`completion_thinking_tokens`）。改为「流式原样、非流式归一」。
- **SF-7 `/healthz` 无鉴权暴露掩码账号 + `lastAnswer` 元数据**：文档明示（`security.md` 已列，建议在 `/healthz` 段补一句「本机任意进程可读」）。
- **SF-8（可选）`Retry-After: 0` → 60s**：如需严格按 `[1,7200]` 应得 1s；当前更保守，仅措辞对齐。

---

## ④ 对「积分扣费」确定性的独立结论

**确定性：低（不足以断言「这 24 token 被服务端扣了积分」）。**

**成立且我独立复核的：**
1. 代码**没有任何本地预扣/记账/余额闸门**：chat 路径不调用 `fetchCredits`、不读余额（`grep` 全仓：`fetchCredits` 仅出现在 `billing/`、`cli`、`serve` 装配、`server.js` 的 credits 路由）。→ 「扣费不在本进程发生」为**确定**。
2. 上游在**流式末帧**返回了 `usage` 块，其中含 `credit` 子字段（报告 §8.3，值 **0**）。→ 「上游对单次请求做**服务端计量**」为**确定**。
3. 余额读取路径 `POST /v2/billing/meter/get-user-resource` 是**只读**计量（`billing/index.js` 无写操作）。→ 「余额只降不升于读路径」为**确定**。

**不确定 / 报告证据不支持的：**
- 「按 token 扣费」且「本次确实扣了积分」：**未证**。`credit:0` 更直接地指向「本次请求计 0 credit」。
- 「余额为何未变」的可能解释（证据化排序）：
  1. **本次请求本就 0 费用**（`credit:0`；或该模型/该时段免费、首 N 次免费）——与观测**最一致**；
  2. **结算延迟 / 批量结算**：`get-user-resource` 返回的是周期容量（`CycleCapacityRemain`/`CapacityRemain`），若结算异步聚合（周期内累计），则两次查询间隔内不可见；
  3. **计量口径粗**：`total` 是整包剩余，24 token 的消耗低于显示/上报粒度；
  4. **余额字段语义不同**：`total` 来自资源包 `remain`，可能不含按量计费部分。
- 无法排除「该账号 `unlimited` 或套餐不计这 24 token」。报告 §8.4 记 `unlimited=false`，但 4 个资源包名与数值已扣留，无法核对。

**结论**：可公开主张的是「本工具不做任何本地计费，用量/计费由上游服务端计算」；**不可**主张「已用余额差值证明扣费」。要确立「按 token 扣费」需一次**显式授权**的前后余额对照（加大 token 量到可观测粒度、并在结算窗口后复测），或上游文档；本阶段证据不足。

> **（指针）** 该「确定性：低」是**当时硬约束（只读、不重跑）**下的结论。后续大请求实验已观测到余额下降（674→673→662），见 `docs/dev/S1-billing-experiment.md`；若执行其 §3 受控归因，可将该档提升为「受控证明」。

---

## ⑤ 能否放行 / 是否可提交推送

- **当前状态：PASS-WITH-CHANGES —— 暂不放行提交/推送。**
- **放行条件**：修掉 **MF-1、MF-2**。（SF-1/2/3/5 建议同批；SF-4/6/7/8 可入 backlog。）
- **修完后可直接 commit（并考虑 push）**：除上述两条外，功能与安全不变量（四道闸顺序/状态码、定时比较 Bearer、`/healthz` 零上游、强 `stream`/`tool_choice`/`developer`/`reasoning_effort` 映射、SSE 增量透传与 `[DONE]`、非流式 tool_calls/usage 折叠、per-model 冷却与 UTC+8/2h、SF-6 封存+错 key/篡改 fail-closed+启动降级告警、刷新只写自有副本+单飞+退避+过期 fail-closed、无遥测/无池/无重试、只绑回环、零 token 泄露、报告结构事实一致）**已由独立证据坐实**。未发现凭据泄露、越权、绕限额或域外联。
- **提交时建议顺带**：删掉真实 own dir 的陈旧 `endpoint.json`；`docs/protocol.md`/`security.md` 的「路由之前」「usage 原样」两处措辞对齐代码。

---

## ⑥ 审查者自证（只读 / 清理）

- 未修改任何仓内既有文件；`git status` 与审查开始时逐字一致；未 commit / push。
- 唯一新增产物 = 本文件（任务要求）。临时夹具脚本 4 个在 `%TEMP%/s1-review/`，其临时目录（`s1-rev-*`、`s1-sf6*`）**已全部删除**；我起的 `serve`（18317）**已终止、端口已释放**；`netstat` 确认无 8317/8318/18317 监听。
- **未发任何真实推理或上游请求**：我起的 `serve` 只用夹具凭据 + 临时 ownDir，且只打 `/healthz` 与「必然被闸拒绝」的路径（无/错 Bearer 的 `/v1/models`、错 content-type 的 POST、`GET /v1/chat/completions` 的 405）；未携带合法 Bearer 触发 `/v1/models`、`/v1/chat/completions`、`/v1/workbuddy/credits`。
- 本文件不含任何 token/账号明文；未读取或复述桌面 auth 文件内容。
