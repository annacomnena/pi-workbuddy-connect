# S2 独立复审 — `models.json` provider 接入（L4 · 只读 · 零上游请求）

- 日期：2026-10-13
- 复审对象：HEAD `6d8b992` + 未提交工作区（S2 改动 + 计费实验产物）
- 被审文件：`docs/dev/S2-report.md`、`docs/dev/S1-billing-experiment.md`、`docs/dev/1013_S2-models-provider.md`
- 规格基准：`~/wb-connect-study/research/20261013_wb_connect_plan.md`、`docs/dev/S1-review*.md`
- 外部 schema 权威：pi 安装目录 `@earendil-works/pi-coding-agent/docs/models.md` + `dist/core/model-config.js`
- 纪律：**只读**；未起 `serve`；**零上游推理**；未 commit/push；未动真机 `~/.pi/agent/models.json`（全程只读，夹具一律 `%TEMP%`）；缺陷注入用完 100% 还原
- 复审者独立执行，**不采信报告自述**；以下所有结论均附本人跑出的证据

---

## ① 总判定

**PASS-WITH-CHANGES（不放行直接提交，修 1 条 must-fix 后可提交/推送）**

- S2 的**核心承诺全部独立复现成立**：命名对齐被 pi 真机认可、只动自己那一段（字节级）、幂等、备份可辨、`--dry-run` 不落盘、schema 合规、150/150 测试且关键用例经注入缺陷证明可区分、零红线违规。
- 计费实验报告**如实、无夸大**：未把观测说成"已受控证明按 token 扣费"。
- 存在 **1 条 must-fix（有效 pi 文件形态下会以误导性信息失败，虽 fail-closed 但属正确性缺陷）** + **3 条 should-fix**。
- 多份 S1 既有文档仍有与新证据冲突的表述，需按 ④ 清单改。

---

## ② A1–A7 逐条复核（判定 + 本人证据）

### A1 命名对齐是否真被 pi 认 —— ✅ 成立

本人执行（离线、只读，`--offline`）：

```
$ node <pi>/dist/cli.js --offline --list-models workbuddy
provider   model                context  max-out  thinking  images
workbuddy  deepseek-v4-pro      1M       128K     yes       yes
workbuddy  deepseek-v4.1-flash  1M       128K     yes       yes
workbuddy  glm-5.3              1M       64K      yes       yes
... （共 18 行；exit 0）
$ node <pi>/dist/cli.js --offline --list-models | wc -l   →  59
```

- 18 行 = 我们那段；全量 59 行（含 1 行表头 = 58 个模型），**其它 provider 一个没丢**。
- 用 **pi 自己的解析器**（`dist/core/model-config.js` `ModelConfig.load`）读**真机** `models.json`：

```
error: undefined
providers: 22 [ 'xingchen-anth', 'krill', 'workbuddy' ]
wb baseUrl/api: http://127.0.0.1:8317/v1 openai-completions
wb models: 18 [ 'hy4-preview', 'hy3', 'hy3-x' ]
```

- 模型 id 与网关 `/v1/models` 的对应关系（前缀自洽性）——**四层同一字符串**，用仓内目录缓存核对（无需起 serve）：

| 层 | 值 | 证据 |
|---|---|---|
| 目录缓存 id | `glm-5.3`（裸 id，无 `workbuddy/` 前缀，18 条） | `%APPDATA%/pi-workbuddy-connect/workbuddy-catalog.json` |
| `models.json` `models[].id` | `glm-5.3` | 真机文件 |
| 网关广告 id（`src/gateway/openai.js` `modelList()`） | `id: model.id`（裸）+ `workbuddy_prefixed_id` | 源码 + 单测 |
| 请求体 model（`stripModelPrefix`） | 带/不带 `workbuddy/` 均接受 | `src/protocol/body.js:21-30,139` |

  **独立核对结果**：缓存 18 条与 `models.json` 18 条 **id 集合完全相等**；`contextWindow`/`maxTokens`/`reasoning`/`input` **逐条一致，0 处不符**；缓存中无任何 `workbuddy/` 前缀 id；因此 `canonicalModelId` 在真机是 no-op。`pi` 引用即 `workbuddy/<裸id>`，与用户口径一致。**判定：自洽成立。**

### A2 只动我们那段（最关键）—— ✅ 成立（字节级）

本人对 `models.json.*.bak`（原始 `0d8e08…`）与现文件（`007ca5…`）做**最长公共前缀/后缀**分析：

```
common prefix len 17404 of orig 17414 cur 23332
inserted len 5918 delta 5918
common suffix len 10
orig[n:n+40] = "\r\n  }\r\n}\r\n"        ← 我们的段直接插在 providers 末尾
cur[n-20:n+60] = "   }\r\n      ]\r\n    },\r\n    \"workbuddy\": {\r\n ..."
```

- 安装 = **原文件（17404 B 前缀逐字节相同）+ 插入 5918 B + 尾部 10 B 逐字节相同**；插入文本以 `,\r\n    "workbuddy": {\r\n` 开头。
- 现文件 22 个 provider、`workbuddy` 为**最后一个键**（键序未变）；原文件 21 个 provider 的字节在上述前缀内**原样保留**。
- 文件仍为**全程 CRLF**（805 个 `\r\n`，无裸 `\n`），2 空格缩进、内联短数组风格保持——`lineDiff`/`detectFormat`/`renderProviderMember` 未重排。
- 备份对比：`models.json.20261013T085208219Z.bak`（卸载前=卸载后状态）**逐字节等于** `models.json.20261013T084843382Z.bak`（原始）；`…085208066Z.bak`（首次安装）**逐字节等于**现文件。
- **并发写风险（新发现，见 ⑤ SF-2）**：实现是 read→算 nextText→write，其间**无锁/无 sha 复核**（TOCTOU）。两次并发 install 内容相同无害；但若用户在 read 与 write 之间编辑了其它 provider，会造成丢失更新。真机未触发；属 should-fix。
- **内联 `providers`（有成员）形态**：见 ⑤ MF-1——会 fail-closed 但报误导性错误。**格式重排影响其它 provider** 在真机与全部展开式夹具上**不成立**。

### A3 幂等与备份 —— ✅ 成立

本人在 `%TEMP%` 用 **真机原始备份**（`0d8e08…` / 17414 B）作夹具，走真实 CLI：

```
ORIG=0d8e085ecb1c7d83ebe34c73b8adfbad6f8444c4fcd1d91c5e7816397c36891d
install #1 → changed:true, backup:…models.json.20261013T090449578Z.bak, write:atomic
installed sha=37e86a4f…  bytes=19412
install #2 → changed:false, backup:null, diff:"", "already installed… 文件未写"; sha 不变；备份数仍 1
uninstall  → changed:true, backup:…090449948Z.bak; sha=0d8e085e… ← 精确回到原值
uninstall#2→ changed:false，"not present; 文件未写"
```

- **幂等**：二次 install `changed:false`、sha 不变、不新增备份 ✅（`current===undefined || !jsonEqual(current, entry)` 逻辑正确）。
- **uninstall 只删我们那段**：回到**原 sha256 `0d8e08…`** ✅；备份目录此时 2 个文件，命名 `models.json.<UTC 毫秒戳>.bak`，冲突时 `-2/-3`（源码 `backupPathFor`，上限 999 抛错）。
- **备份仅在真正写入时生成** ✅（dry-run 与 `changed:false` 均不产生备份）。

### A4 `--dry-run` 真不落盘 —— ✅ 成立

同上夹具（CLI `--json --dry-run`）：

```
sha after dry-run = 0d8e085e…（= ORIG，未变）
backups dir exists: NO  （0 个文件）
diff 含 '+    "workbuddy": {'，apiKey 以 <gateway bearer secret> 占位
```

- 落盘前**未创建** `config-backups/`；`document.backup === null`；`dryRun:true`。✅

### A5 schema 合规 —— ✅ 成立（含 apiKey 说明）

- **键集与 pi schema 逐位相等**（本人对源码集合做差集）：`PROVIDER_KEYS`（10）= `ProviderConfigSchema`；`MODEL_KEYS`（15）= `ModelDefinitionSchema`；`COMPAT_KEYS`（22）= `OpenAICompletionsCompatSchema`；`COST_KEYS`（5）= `ModelCostSchema`。**无多、无缺**。
- provider 段取值：`baseUrl`(string) / `api:"openai-completions"` / `apiKey`(string) / `compat`(5 键，均在 union 分支内) / `models[]` 均合规；pi `ModelConfig.load` 对真机文件 `error: undefined`。
- **`cost` 全 0 不会造成 pi 侧异常**：`ModelCostSchema` 要求四费率均为 number，0 合法；`cache-warmer.js:evaluate` 有 `economicsAvailable`（零费用时为 false）保护、无除零；`usage-totals` 只做加法。pi 会话成本显示为 0，真实计费在上游——与 `docs/mechanism.md`「不做本地记账」一致。**判定：无异常。**
- **`apiKey` 是否引用环境变量名（A5 关键问）——报告称 `--api-key-env`，机制属实，但真机落盘为明文**：
  - 机制 ✅：`apiKeyField()` 在 `tokenSource==='env'` 时写 `$WORKBUDDY_GATEWAY_TOKEN`；`--api-key-env NAME` 写 `$NAME`；`docs/models.md` 明确 `$NAME`/`${NAME}` 插值语义。本人夹具实测写入 `apiKey = $WORKBUDDY_GATEWAY_TOKEN`。
  - **真机现状 ❌**：现 `~/.pi/agent/models.json` 的 `providers.workbuddy.apiKey` = **明文网关 bearer**（本人核对，此处不打印）。报告 §7.3/§1 **如实披露**了此默认（"默认写字面量"）并给出 `--api-key-env` 逃生口——**报告未虚假声称真机用了 env**。归类为 should-fix（见 ⑤ SF-1），非 report 造假。
- 附带核实：`supportsUsageInStreaming:false` **不会丢 usage** —— pi-ai 流式解析 `chunk.usage` 与 `choice.usage` 是**无条件**的（`pi-ai/dist/api/openai-completions.js:363-372`），该 flag 仅决定是否发送 `stream_options:{include_usage:true}`（:582）。报告 §7.6 的取值与理由**成立**。

### A6 测试真实性 —— ✅ 成立（mutation 验证）

- 本人跑：`timeout 300 node --test` → `# tests 150 / # pass 150 / # fail 0`（耗时约 10.0 s），与报告一致。`test/provider-install.test.js` 实为 **22** 个用例（逐条点数）。
- **用例真能区分修复前后**（本人注入缺陷 → 跑测 → 还原，且 sha 自证还原）：
  - 保存原件 sha：`models-json.js=ef19c5cb…`、`install.js=7c461280…`。
  - **M1（幂等）**：把 `changed = current===undefined || !jsonEqual(...)` 改为 `changed = true` → **2 例失败**（`install is idempotent`、`CLI installs… is idempotent`）。
  - **M2（install 逐字节保留）**：`spliceProvider` 改为整文件 `JSON.stringify` 重序列化 → **5 例失败**（含"其它 provider 逐字节不变"、"uninstall 回到原字节"、CLI 端到端）。
  - **M3（uninstall 恢复原字节）**：`spliceProviderRemoval` 改为整文件重序列化 → **3 例失败**（含"install + uninstall 必须回到原始字节"）。
  - 每次还原后 `sha256sum` 与原值**完全一致**；三次突变后 `git status --porcelain` 与起始**完全相同**（无新增/丢失改动）。**判定：测试非空转，targeted。**
- 测试卫生：全部用 `mkdtempSync` 沙箱 + `--models-json`，`APPDATA` 指向沙箱；未读真机 `~/.pi/agent/models.json`、未联网、未跑 App 密钥 helper（本人通读确认）。

### A7 红线 —— ✅ 未越线

| 项 | 结论 | 证据 |
|---|---|---|
| 未发任何上游推理 | ✅ | 本人只跑 `--offline --list-models` + 动态 `import` + 离线 CLI 夹具；命令均 `timeout` |
| 未起 `serve` | ✅ | 未执行 `serve`；`netstat` 中 `:8399` 为空，`:8317` 是本机既有 `cli-proxy-api.exe`（pid 771116，非本工具） |
| 未 commit/push | ✅ | `git log -1 = 6d8b992`；`git status` 仅原工作区改动 |
| 未动企业/国际分支 | ✅ | `git diff --name-only` = README/protocol/cli/config/errors/gateway.openai/gateway.server/gateway.test；未触及 variant/enterprise 逻辑 |
| 未打印密钥 | ✅ | 仓库全文件 grep 真实 token → **0 命中**；human 输出实测只显示掩码（如 `JSUY…fWx4`）+ `value never printed`；diff 用 `<gateway bearer secret>` |
| 未动真机 `models.json` | ✅ | 本人全程只读，sha 仍 `007ca501…` |
| `s1-billing-probe.mjs` 无明文凭据 | ✅ | 通读：bearer 仅来自 `WORKBUDDY_GATEWAY_TOKEN` 或 `gateway.json`，无硬编码；无账号/余额明文 |

---

## ③ B 段：计费实验证据复核 + 最小受控实验设计

### B-1 三组数值是否如实 —— ✅ 如实，无夸大

| 时点 | total | pack0 | 报告写法 |
|---|---|---|---|
| 前测 | 674 | 374 | ✅ |
| 大请求后立即 | 673 | 373 | ✅（−1） |
| 约 1.5–2 h 后 | 662 | 362 | ✅（较前测 −12） |

三组数值内部自洽（374+300=674；362+300=662；−12 = pack0 独降）。报告**主动**标注"−12 无法逐笔归因"，并列出四条可能来源（①大请求结算成本 ②实验 run 可能还发过调用 ③桌面 App 自身在跑 ④结算延迟补扣）——本人核实：**③ 客观存在**（当前 `tasklist` 有 **8 个 `WorkBuddy.exe` 进程**在运行），故"归因不干净"**属实、非托词**；② 报告明确写"实际次数未经独立核对——需复核"，属**如实存疑**而非掩盖。

### B-2 是否把观测说成"已受控证明按 token 扣费" —— ✅ 没有

报告 §2 明写：❌「仍不能断言：本次这 N 个 token 被精确扣了 X credit」，并把受控归因列为**待用户再授权**的下一步。措辞为"**已观察到的确定事实：余额会随使用下降**"，属观测事实陈述，未升级为因果定论。**无过度归因。**

### B-3 本人独立结论（档位）

**证据支持到第一档「余额随使用下降已观察」**，更严格表述为：**在含一次已知大请求的观测窗口内，余额单调下降（674→673→662）；但"下降由该请求按用量导致"尚未受控证明。**

- **不是第三档"证据不足"**：确实观测到下降，且大请求后**立即** −1（时间相邻），不是"没变化"。
- **不到第二档"受控证明按用量扣费"**：观测窗口内存在未受控变量（桌面 App 8 进程、实验 run 次数未核、结算延迟）。特别是 **673→662 的 −11 期间我们并无已核调用**，说明存在"非本次请求"的消耗或延迟结算，**必须**用无调用对照窗口排除。

### B-4 最小受控归因实验设计

目标：把"余额下降"从观测升到"按 token 用量扣费"的受控证明。**推理调用 ≤2 次**（沿用现有授权上限）。

1. **前提（用户动作）**：在实验窗口内**完全退出 WorkBuddy 桌面 App（8 个进程全部结束）**，并**不使用任何**其它会调上游的客户端（含本工具 `serve`、其它读本网关的程序）。确认 `tasklist | findstr WorkBuddy` 为空、`:8317` 无本工具监听。
2. **对照窗口（0 次调用，关键新增）**：起 `serve`（**空闲端口，避开 8317**）→ 读 credits `C0` → **静置 ≥15 min，期间零调用/零 App** → 读 credits `C1`。**要求 `C1 == C0`**（证明"无用量 → 余额不动"）；若仍有下降，则实验环境不干净，**中止并改条件重来**。
3. **一次已知规模请求**：固定 prompt + 明确 `max_tokens`（如 1500–2000），记录上游 `usage`（prompt/completion/total tokens 与 `credit`）。
4. **结算读取**：请求后 **+30 s** 读 `C2`，**+15 min** 读 `C3`（分两次以分离"即时"与"补扣"）。要求 `C1==C3` 的稳定性已由步骤 2 保证。
5. **判定**：若 `C2/C3 < C1` 且 `C1==C0`（无其它变量），则差额即该请求成本 → **受控证明"按用量扣费"**，并给出 `Δcredit / total_tokens` 倍率。
6. **线性核验（可选，第 2 次调用）**：再做一次**不同规模**请求（如 ×2 输出），验证 `Δcredit` 近似成比例 → 从"扣费"升级为"按 token 线性扣费"。
7. **清理**：结束 `serve`、删除 `endpoint.json`、无残留进程/端口。

> 说明：若用户不愿退出 App，则第 2 步无法成立，**只能停留在第一档**，应如实这么写，不得再用一次大请求冒充受控。

---

## ④ 需要改的文档行清单（与本次新证据冲突）

> 原则：S1 原始实测值**不改写**；加"已被新实验覆盖/需并读"的指针或更新结论句。

**`README.md`**
- **L243**：`- **余额变化不可立即观测**：真实推理后余额字段可能不立刻变化（本次实测前后均 total 692），因此「服务端按 token 扣费」的证据是上游返回的 usage…` —— **与新证据冲突**（大请求后立即 −1、随后 −12，余额**会**变）。改为："余额变化**可能延迟**且受其它客户端影响（详见 `docs/dev/S1-billing-experiment.md`：观测到 674→673→662）；`usage` 是逐请求证据，余额差值是**旁证**。"

**`docs/dev/S1-report.md`**
- **L21**（§1 表「积分是否可见变化 | ❌ 未观察到」）—— 属小请求会话记录，加括注"（该结论仅适用于 24 token 小请求；大请求实验见 `S1-billing-experiment.md`，已观测到下降）"。
- **L24**（未做项"余额变化未观测到"）—— 加"（后续大请求实验已观测到下降，归因待收口）"。
- **L206**（§8.2 表 `total 前后完全相同`）—— 加"（小请求、24 token；见 S1-billing-experiment.md 的对照）"。
- **L235**（§8.4 标题「关键结论：未观察到减少」）与 **L242**（"24 token 的消耗在余额字段上不可观测"）—— 加"（**已被** S1-billing-experiment.md 的大请求观测**部分取代**：大请求后立即 −1、1.5–2 h 后 −12）"。
- **L245 / L246–251**（"本会话没有任何证据表明…"、"余额为何未变的四种可能解释"）—— 保留（对本会话成立），加"后续实验补充了第 5 条可能来源：**其它客户端/桌面 App 同期消耗**"。
- **L253**（"要确立『按 token 扣费』需要一次显式授权的前后余额对照…"）—— 加"（**已启动**：见 S1-billing-experiment.md §3 需要用户再授权 1 次）"。
- **L287**（未做项 3"余额变化未观测到"）—— 同 L24 处理。

**`docs/dev/S1-review.md` / `S1-review2.md`**
- **S1-review.md L154、L196–214**（"无法独立验证""确定性：低"）—— 属当时硬约束下的结论，加指针即可："后续若执行 S1-billing-experiment.md §3，可将该档提升为受控"。
- 其余（MF-2 整改核对）**不冲突**，无需动。

**`docs/dev/S2-report.md`**
- 报告 §"计划：`plans/1013_S2-models-provider.md`"及 §4 表同处 —— **路径错误**，实际文件在 `docs/dev/1013_S2-models-provider.md`（本仓无 `plans/` 目录）。见 ⑤ SF-3。

---

## ⑤ must-fix / should-fix（每条最小修法）

### MF-1（must-fix）：内联且非空的 `providers` 对象 → 以**误导性错误**失败

- **现象（本人复现）**：夹具 `{"providers": { "alpha": { … } }}`（单行、有成员，**是 pi 合法可读的 models.json**）执行 install →
  `THREW: the edited models.json would not parse (Expected double-quoted property name…); nothing was written`，文件未变（fail-closed ✅）。
- **根因**：`models-json.js` `spliceProvider()` 追加分支用 `memberIndent = indentOf(providers[0].keyStart)`；当首个成员与 `"providers": {` 同行时，`lineIndentAt` 返回的是整行前缀（含 `"providers": { `），导致新成员缩进被写成嵌套垃圾。`assertSpliceSafe` 兜住了（未损坏文件），但**输入合法却报"would not parse"，且该形态永远装不上**。
- **影响面**：真机 `models.json` 是展开式，**当前不受影响**；对紧凑手写/其它工具生成的 models.json 会失败。
- **最小修法**：在 `spliceProvider` 中，当 `text` 在 `[providersOpen, providers[0].keyStart)` 内**不含换行**（即对象是内联的）时，走"展开"路径：`memberIndent = lineIndentAt(providersMember.keyStart) + indentUnit`、`closingIndent = lineIndentAt(providersMember.keyStart)`（与既有"内联空 `{}`"分支同款处理）。并新增 1 个用例：内联有成员 → 安装成功且其它 provider 原文不变。若选择不支持，则至少把错误改为明确的 `models-json-unreadable`-类提示（说明"该文件把 providers 写在一行，请展开或手工添加"）。

### SF-1（should-fix）：真机 `models.json` 落盘**明文**网关 bearer

- **现状**：`providers.workbuddy.apiKey` 为明文（本人核对，不打印）。报告如实披露，且项目对密钥落盘有 `gateway.json`(0600) 的既有约定；`models.json` 会被 pi 与 subagent-win 读取，属**额外的密钥副本面**。
- **最小修法**：二选一——(a) 把 README/报告里的**推荐命令**改为 `install-provider --api-key-env WORKBUDDY_GATEWAY_TOKEN`（并在 `serve` 环境注入同名变量），仅保留字面量作为"无 env 时的显式选择"；或 (b) 保持默认字面量，但在 `install-provider` 成功输出**顶部**追加一条醒目 warning（现已在 `warnings[]`，可提升为 human 输出的首行提示）。不改代码逻辑即可 (b)。

### SF-2（should-fix）：read→write 之间无并发/丢失更新防护（TOCTOU）

- **现状**：`installProvider`/`uninstallProvider` 读取、计算、写入之间无锁、无 sha 复核；若同窗口内用户/其它进程改了**其它** provider，会被整体覆写为基于旧快照的文本（ephemeral lost update）。真机未触发。
- **最小修法**：写入前（备份后、`writeModelsJson` 前）重新 `statSync`/读取比对"读取时的 mtime+size（或 sha256）"，不一致则**拒绝写入并提示重试**（fail-closed）。约 10 行，无需加锁。

### SF-3（should-fix）：S2 报告计划路径写错

- **现状**：报告写 `plans/1013_S2-models-provider.md`，实际为 `docs/dev/1013_S2-models-provider.md`（本仓无 `plans/`）。
- **最小修法**：报告两处路径改为 `docs/dev/1013_S2-models-provider.md`（或在仓内补 `plans/` 目录并移动该文件，二选一，注意不要与 `docs/` 双份并存）。

### SF-4（should-fix）：S1 既有文档与新证据冲突行

- 见 ④ 清单（`README.md L243` 为最需改的一条）；最小修法为"加指针/更新结论句"，不重写原始实测值。

> 未升级为 must-fix 的观察（无需改码，仅记录）：
> - 原地写降级（EPERM 时）非原子，进程中途被杀理论上可截断——报告 §7.5 已披露，且有备份，可接受。
> - 纯 JSON 限制（拒绝带注释的 JSONC）：fail-closed + 提示，可接受。

---

## ⑥ 是否可提交/推送

**当前不可直接提交/推送；修完 MF-1 即可（should-fix 建议同批处理，但不阻塞）。**

- 提交前最小动作：修复 MF-1（内联 providers 处理或清晰错误）+ 补 1 个用例 → 重跑 `node --test` 应仍 150+（≥151）全绿；`git diff` 自查无越界。
- 提交信息建议沿用既有 convention（`feat(s2): …`）；**提交前确认** `~/.pi/agent/models.json` 的安装状态是用户期望的（现为已安装，`007ca5…`），并把 `docs/dev/S2-report.md` 的计划路径改正（SF-3）。
- SF-1（明文密钥）建议在提交前决定口径：若采纳 `--api-key-env` 为推荐路径，则 README 示例与报告结论需同步。
- 红线复核：本复审**未**产生任何 commit/push，**未**改真机 `models.json`。

---

### 附：本人本次运行的关键命令与结果（可复现）

```
1) node <pi>/dist/cli.js --offline --list-models workbuddy   → 18 行, exit 0
2) node <pi>/dist/cli.js --offline --list-models | wc -l      → 59
3) node -e "import('<pi>/dist/core/model-config.js').then(m=>m.ModelConfig.load('~/.pi/agent/models.json'))" → error: undefined, 22 providers
4) sha256 真机 models.json = 007ca501…（23332 B，22 providers）; 原始 bak = 0d8e085e…（17414 B）
5) 前缀 17404 B 逐字节相同，插入 5918 B，尾 10 B 相同
6) 临时夹具 CLI：dry-run 不落盘/不备份；install 幂等；uninstall 回到 0d8e08… 原 sha
7) timeout 300 node --test → 150/150 pass
8) mutation M1/M2/M3 → 分别 2/5/3 例失败；还原后 sha 与原值一致，git status 不变
9) 仓库 grep 真实 token → 0 命中；:8399 无监听；HEAD 仍 6d8b992
```

- 本人临时夹具与注入还原均已清理（`/tmp` 临时目录已删；repo 文件 sha 与原值一致）。
