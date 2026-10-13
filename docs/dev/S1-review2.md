# S1 整改独立复审（L4 · 另起进程 · 只读 · 对抗式）

- 日期：2026-10-13
- 对象：`pi-workbuddy-connect` 未提交工作区 = S1 本体 + 本轮整改；`HEAD=531d77e`，分支 `main`
- 权威待修清单：`docs/dev/S1-review.md`（PASS-WITH-CHANGES，2 must-fix + 8 should-fix）
- 被审整改报告（**不采信自述**）：`docs/dev/S1-report.md` §12
- 方法：静态对照 + **自造夹具独立复现**（注入假 `chatStream`、假 store，本地回环，无网络）+ **注入缺陷自证测试可区分性** + 纪律核对
- 硬约束遵守：**未发任何真实推理/上游请求**（全部走注入假 client）；未 commit/push；未动其它仓 / `~/.workbuddy` / 桌面 auth 文件；临时夹具 100% 还原并自证；跑完清理进程/端口/自有临时目录
- 本文件不含任何 token / 账号明文

---

## ① 总判定

**PASS** —— 2 条 must-fix（MF-1、MF-2）与 8 条 should-fix（SF-1…SF-8）**逐条独立复现到位**；回归 128/128 全绿；MF-1/SF-1 新用例经注入缺陷验证**确能区分修复前后**；范围/纪律干净。
**结论：可提交 / 可推送。** 未闭合 must-fix/should-fix = **0**（仅 2 条非阻塞 nit，见 §③）。

---

## ② 逐条复核（判定 + 我跑出的证据）

### 1. MF-1（流式假成功）—— 判定：PASS

**静态**：`src/gateway/server.js:329-338` 先 `await iterator.next()` 取首个 chunk，**之后**才 `res.writeHead(200, SSE_HEADERS)`；首个 chunk 抛错 → `return failAttempt(error)`（走 502 映射）。`src/gateway/openai.js:101-106` 的 `truncatedStreamFrame()` 产 `{"error":{...,"type":"workbuddy_truncated"},"workbuddy_truncated":true}`。

**自造夹具实测**（`%TEMP%/s1-review2/probe.mjs`，注入假 `chatStream`，HTTP 打本地回环，零上游）：

| # | 情形 | 实测 | 判定 |
|---|---|---|---|
| MF-1.1 | 零字节转发前报错 | **502** `{"type":"upstream_error"}`（**非 200、无 `[DONE]`**） | ✓ |
| MF-1.2 | 多帧后报错 | 200；`frames=5`，truncated 帧 **idx=3** < `data: [DONE]` **idx=4**；含 `"workbuddy_truncated":true` | ✓ |
| MF-1.3 | 正常结束但上游**没发** `[DONE]` | 200；truncated 帧 **idx=3** < `[DONE]` **idx=4** | ✓ |
| MF-1.4 | 正常且上游自带 `[DONE]` | 200；**无** truncated 标记、`[DONE]` 恰好一次 | ✓ |

**对抗性边界（`%TEMP%/s1-review2/edge.mjs`）**：① 上游先 enqueue 空串再报错 → **502**（不是 200，未误计为"已转发"）；② 流式模式抛 `upstreamError(429)` → **429 `soft_rate`**（保留映射，未退化成 502）；③ 非流式抛 401 → **401 `session_dead`**。

---

### 2. MF-2（报告过度主张）—— 判定：PASS

逐句核对 `docs/dev/S1-report.md`：

- §1（L21）/§8.4（L243-244）只主张两类事实：「**上游做服务端计量**」「**本工具不做任何本地预扣/记账/余额闸门**」✓
- §1（L21）/§8.4（L245）明确：「**本会话无证据表明这 24 token 被扣费**」✓
- §8.4（L246-251）列出**四种**可能解释：①本次 0 费用 ②结算延迟/批量结算 ③计量粒度粗 ④余额字段语义不同 ✓
- **没有**把 `credit:0` 当扣费证据：§8.3（L233）明写「`credit:0` **不能**作为『这 24 token 被扣了积分』的证据，反而更直接地指向『本次请求计 0 credit』」；§8.4 与 §12.1 同调 ✓
- §8.2/§8.3 原始实测值未被改写，§8.4 保留「余额前后完全相同」✓

---

### 3. SF-1（非流式折叠中途报错）—— 判定：PASS

静态：`server.js:378-397` 以 try/catch 包裹折叠；`streamError!==null && rawChunks===0` → `failAttempt`（502）；有部分帧 → 保留 partial + `completion.workbuddy_truncated = true`。

自造夹具实测：

| 情形 | 实测 | 判定 |
|---|---|---|
| 零有效帧后报错 | **502** `upstream_error`（**不再是 500 `internal`**） | ✓ |
| 部分帧后报错 | **200** + `workbuddy_truncated:true` + `content="Hello world"`（保留部分答案） | ✓ |

---

### 4. SF-2 / SF-3 / SF-5 / SF-6（文档措辞 · 运行时降级告警 · endpoint 清理）—— 判定：PASS

- **SF-2（404 先于 Bearer 措辞）**：`docs/security.md:30` 改为「four gates before it **dispatches to a route** or calls the upstream」；`:49-52` 明示「Route matching happens **between gates 2 and 3** … 404 before bearer … wording deliberately 'before dispatch', not 'before routing'」。`docs/protocol.md:115-118` 同步。
  **代码核对**：`server.js:419-434` 精确顺序 = Host(403) → Origin(403) → 路由匹配(404) → Bearer(401) → 非 GET JSON(415) → 方法(405)。**运行时实测**：`GET /v1/nope`（无 Bearer）→ **404 `not_found`**。文档与代码一致 ✓
- **SF-6（usage 措辞）**：`docs/protocol.md:121-124` 改为「流式**原样透传**（含 `credit` 等子字段）；非流式**归一**为 `prompt_tokens`/`completion_tokens`/`total_tokens`，丢 `credit`/`completion_thinking_tokens`」。**运行时实测**：非流式折叠 `usage={"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}`，`credit` 与 `completion_thinking_tokens` **均被丢弃**；流式帧原样透传。一致 ✓
- **SF-3（运行时 SF-6 降级真有 warn）**：`src/credentials/index.js:126-133` `seal()` 降级时 `logger.warn('SF-6 DEGRADED at runtime: …')`（实例内去重）；`src/serve.js:74-83` 向 store 传 `logger`。**运行时实测**（freebsd + 明文桌面，`%TEMP%/s1-review2/sf35.mjs`）：连续两次 `writeOwnCopy` → `keySource=none degraded=no-protection-available`，**warn 恰 1 条**，含 `SF-6 DEGRADED at runtime` 与 `plaintext` ✓
- **SF-5（endpoint 陈旧清理真的生效）**：`src/gateway/secret.js:98-133` 新增 `removeStaleEndpointFile()`（`process.kill(pid,0)` 判活，EPERM 视为存活，死 pid/坏 JSON → 删）；`src/serve.js:69-72` 启动调用；`:188` 关闭 `removeEndpointFile()`。**运行时实测**：
  - 纯函数：死 pid → 删；坏 JSON → 删；**活 pid → 保留** ✓
  - 集成：`startServe` 后 `endpoint.json` 存在；`close()` 后**已删除**；注入「指向死 pid 的残留」后再次启动 → info 日志 `removed a stale endpoint.json …`，残留被清 ✓
  - 真实 own dir `%APPDATA%\pi-workbuddy-connect\` 现**只剩** `gateway.json` 与 `workbuddy-catalog.json`，**无 `endpoint.json`**（与报告 §12.2「已删除」相符）✓
- **SF-4（附带核验）**：`src/billing/index.js` 已无硬编码 URL 直连，两条计费路径统一走 `client.url(billingBaseFor(credential), …)` ✓
- **SF-7**：`docs/security.md:65-66`、`docs/protocol.md:110` 明示 `/healthz` **本机任意进程可读**、仅掩码元数据。运行时实测 `/healthz` 无 Bearer 返回 200，**不含** Bearer/凭据 ✓

---

### 5. 回归与测试真实性 —— 判定：PASS

**全量回归（真实输出，`timeout 300 node --test`）：**

```
# tests 128
# suites 0
# pass 128
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9234.7363
```

**MF-1/SF-1 用例可区分修复前后（注入缺陷 → 红，还原 → 绿）：**
临时把 `server.js` 改回「先 `writeHead(200)` 再读首帧 + 去掉截断信令 + 折叠异常冒泡」后跑 `test/gateway.test.js`：

```
not ok 9  - a stream that fails before its first frame is 502, not an empty 200 (MF-1)
not ok 10 - a stream that fails mid-answer is marked workbuddy_truncated before [DONE] (MF-1)
not ok 11 - a stream that ends without [DONE] is marked truncated (MF-1)
not ok 13 - a truncated stream is marked instead of being reported as complete
not ok 14 - a non-streaming fold that fails before any frame is 502, not 500 internal (SF-1)
not ok 15 - a non-streaming fold that fails mid-answer keeps the partial answer, marked truncated (SF-1)
# tests 24 / # pass 18 / # fail 6
```

**还原自证**：`src/gateway/server.js` sha256 注入前 = 还原后 = `d451edcb…76fa270`（一致）；`test/gateway.test.js` sha256 全程未变 = `1bb4ed63…7163c2`；还原后 `# tests 24 / # pass 24 / # fail 0`。**100% 还原** ✓

---

### 6. 范围 / 纪律 —— 判定：PASS

- **只动本仓**：`git status --porcelain` = 29 条，与整改前一致；`subagent-win` 工作区干净；全仓无 `G:/code` 引用。
- **无 commit / push**：`HEAD=531d77e`（S3）；`git reflog` 顶部仍是该 S3 提交；`git status -sb` 为 `## main...origin/main`（**不 ahead / 不 behind**）；`git diff --cached` 为空（无暂存）。
- **无残留进程/端口**：`netstat` 无 `8317`/`8318` 监听；无 `node … serve` 形式的 `pi-workbuddy-connect` 进程（仅本复审 agent 自身的命令行含该串，非 serve）。我自起的 `serve`/网关均为端口 `0` 且已 `close()`。
- **零上游请求**：
  - 代码可达面：`src/` 内 `fetch` 引用**唯一**在 `src/upstream/client.js:189`（`this.fetchImpl`），其 3 个出站点（`:205` 目录 / `:261` chat / `:298` refresh）**全部**经 `this.url()` → `upstreamUrl()` 的 `UPSTREAM_HOSTS` 白名单前置校验。
  - 我的全部复现使用注入假 `chatStream`/假 store，只打本地回环 `/healthz`、`/v1/*` 与「必然被闸拒绝」路径；**未携带合法 Bearer 触发任何上游路径**。
  - 报告 §12.3 的零上游本地自测状态码（200/401/404/401/403/405/415）与审查 §1 表一致，无回归。
- **`%TEMP%` 残留**：我本次 `node --test` 产生的 `pwc-*` 测试临时目录**已删除**；其余历史 `pwc-*`（967 个，`node --test` 不清理临时目录的既有现象）非本次产生、未触碰。我的夹具目录 `%TEMP%/s1-review2/` 收尾删除。

---

## ③ 仍未闭合项

**must-fix / should-fix：0 条。**

非阻塞 nit（不影响放行，供后续顺手处理）：

1. **截断帧 message 文案含字面 `[DONE]`**：`truncatedStreamFrame` 的 message 形如「…ended without **[DONE]**; the answer is truncated」。以裸子串 `includes('[DONE]')` 判终止符的**朴素**客户端可能误判；结构化字段 `workbuddy_truncated:true` 仍无歧义（本次复审即因此先误报、后改用精确终止符匹配）。建议未来把 message 里的 `[DONE]` 写作 `the terminator` 之类。
2. **`node --test` 临时目录泄漏**：测试套件在 `%TEMP%` 累积大量 `pwc-*` 目录（既有现象，非 S1 代码缺陷）。可加 `after()` 清理。

其余（审查曾列为可选/仅文档）：Bearer 长度短路侧信道加固、SF-8 `Retry-After:0→60s` 更保守措辞——均按报告维持**不改行为**，属可接受。

---

## ④ 是否可提交 / 推送

**是。** 前一轮（`S1-review.md`）设定的放行条件「修掉 MF-1、MF-2」已满足，且 SF-1…SF-8 全部独立复现到位；128/128 回归绿、目标用例可区分、范围与纪律干净。
**建议**：提交时一并纳入 `docs/dev/S1-review.md`、`docs/dev/S1-report.md`、本文件；推送前无需再改代码。

**未能独立验证项（沿用声明）**：报告 §8 的真实推理次数、`credits` 前后 `total`、流式末帧 `credit` 值——需真实上游请求，本轮硬约束禁止，维持「无法独立验证」；本轮只判整改到位性。

---

## ⑤ 复审者自证（只读 / 清理）

- 未修改任何仓内既有文件；`git status` 与开始时一致；未 commit / push。
- 唯一新增产物 = 本文件。
- 注入缺陷已 100% 还原（`server.js` sha256 注入前=还原后；`gateway.test.js` 全程未变），有 hash 证据。
- **未发任何真实推理或上游请求**（全部注入假 client + 本地回环）。
- 我起的本地网关均端口 `0` 且 `close()`；`netstat` 确认无 `8317`/`8318` 监听；我产生的 `%TEMP%/s1-review2/`、本次 `pwc-*` 测试临时目录已删除。
- 本文件不含任何 token / 账号明文。
