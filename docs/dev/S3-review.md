# S3 独立审查（L4 · 另起进程 · 只读 · 对抗式）

- 日期：2026-10-13
- 被审对象：`pi-workbuddy-connect` 未提交工作区（`bin/`、`src/`、`test/`、`package.json`、`THIRD-PARTY-NOTICES.md`、`README.md`、`docs/security.md`）
- 被审报告：`docs/dev/S3-report.md`（**不采信自述**）
- 规格基准：`~/wb-connect-study/research/20261013_wb_connect_plan.md`、`..._research.md`（Q1–Q7 / R1–R12 / Do-NOT 13 条）
- 上游参照（只读，MIT）：`~/wb-connect-study/package/lib/host-heartbeat-DpaqHdXw.js`、`lib/index.js`
- 方法：独立跑命令 + 自造信封夹具 + net-block shim（阻断 fetch/net/dns/tls）+ 静态对照；**未发任何上游网络请求**（未跑 `--network` / `status` 默认联网路径）
- 本文件不含任何 token 明文、账号值或可复现的账号标识；掩码样本仅以占位符描述

---

## ① 总判定

**PASS-WITH-CHANGES** —— 功能与安全不变量成立（解密正确、fail-closed、桌面只读、测试无网络、无推理/遥测/重试），但有 **2 条 must-fix**：归因声明不实、helper 运行失败原因码错配。二者修掉即可放行进 S1。

---

## ② 逐条复核

### 1. 脱敏是否真的不漏 —— 判定：PASS（附 1 条 should-fix）

**我自己跑的证据**（均在 net-block shim 下通过，`status`/`doctor` 用 `--no-network`）：
- `status --json --no-network`（真实凭据）：`auth.desktopPath`/`ownCopyPath` 折 `~`；`keyIdMasked` 4+4（keyId 本身是信封内的明文元数据，非密钥）；`account.uidMasked` 3+2（uid 实长 36）、`uinMasked` 3+2（uin 实长 12）；`accessTokenMasked`/`refreshTokenMasked` 4+4；无完整 token / uid / uin / 明文昵称（`nickname: null`）。
- `doctor --json --no-network` 与 `doctor --json --no-network --decrypt`：字段同构，无凭据本体；`redactionSelfCheck.ok=true`。
- 用我自己的正则复跑报告 §3.3 的 grep（JWT / Bearer / `X-Refresh-Token` / `$wbEncrypted` / `"ciphertext"`）→ **0 命中**。
- 仓库 grep：仅命中字段名 `X-Refresh-Token`（`src/upstream/headers.js:83`）与 **公开测试向量**（`test/redact.test.js` 的 jwt.io 示例）；`docs/**` 无值；**git 历史** `git grep` 0 命中；无 `*.info` / `*auth*.json` 被跟踪。
- **自检是否名副其实**：自造「`domain` 字段 = JWT 形状」的凭据（`domain` 本会原样打印）→ 输出被替换为 `{"error":{"reasonCode":"redaction-self-check-failed"}}`，人类输出亦被扣留，**退出码 1**。证明 `finalizeDocument`（`src/cli.js:92-108`）是**承重**的，不是装饰字段。

**观察（should-fix）**：`README.md:86-91`（及 `docs/dev/S3-report.md` 示例）嵌入了**来自真实数据的掩码样本**（uid/uin/keyId/token 局部、余额数值、套餐名）。虽非明文、不构成可用凭据，但属账号相关数据进入公开仓；建议换自造示例。另 `maskIdentifier`（`src/util/mask.js:21-25`）对 6 字符值会暴露 5/6 字符；当前 uid=36 / uin=12，无实际风险，属边界。

### 2. 解密实现对不对 —— 判定：PASS

**与上游契约逐条对照**（`src/credentials/at-rest.js` / `electron.js`）：
| 契约点 | 上游 | 本仓 | 结论 |
|---|---|---|---|
| AAD 前缀 + 帧族 + 尾 | `WB-AAD\0`,`[1]`,lp(`WBEV1`),lp(`sym-v1`),suite,keyId,`[2][0][0]`（HB#1904-1944） | 同（`at-rest.js:36-50`） | 一致 |
| 信封结构 | `{$wbEncrypted:1, envelope:<b64 JSON {suite,keyId,nonce,authTag,ciphertext}>}`（HB#1800-1840） | 同（`at-rest.js:71-96`） | 一致 |
| keyId 校验 | `/^[0-9a-f]{16}$/`（HB#1832） | 同（`at-rest.js:22,86`） | 一致 |
| AES-256-GCM | key32 / nonce12 / tag16（HB#1930-1944） | 同（`at-rest.js:81-84,142-145`） | 一致 |
| helper 调用 | `ELECTRON_RUN_AS_NODE=1` + `-e process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`（HB#2803-2804,2635-2654） | 同，脚本字符串逐字一致（`electron.js:24-27,293-317`） | 一致 |
| keyId 派生 | `sha256(key).hex().slice(0,16)`（HB#2475-2482） | 同（`at-rest.js:192-194`） | 一致 |

**我自造的夹具（16 项全 PASS）**：AAD 字节级独立重算比对相等（len=54）；正确 key 可开；**错 key / 篡改 authTag / 篡改密文 / 信封 keyId 换值（AAD 绑定）/ 非 12B nonce** 全部失败返回 `undefined`；`suite=2`、坏 envelope、非字符串非信封 → `unrecognized`（绝不退化成 plaintext）；payload 全零 / 非规范 base64 / 空 secret → 拒绝。

**CLI 级**：用真 App 二进制解一个自造信封 → `credential-undecryptable`，`keyIdMatched=false`，错误消息只回显信封 keyId 前 4 hex（`credentials/index.js:165-175`）。正确凭据则 `keyIdMatched=true`、双 token 解出。

### 3. fail-closed 与原因码 —— 判定：PASS-WITH-CHANGES（1 条 should-fix + 1 条 status 语义）

桩/夹具实测触发：

| 场景 | 实测码 | 退出码 | 结论 |
|---|---|---|---|
| 不存在 / 空文件 | `credential-missing` | 1 | ✓ |
| 坏 JSON | `credential-unreadable`（status+doctor） | 1 | ✓ |
| keyId 不匹配 | `credential-undecryptable` | 1 | ✓ |
| 显式坏 `--electron` 路径 | `electron-not-found` | 1 | ✓ |
| region 不匹配 | `credential-region-mismatch` | 1 | ✓ |
| session 全过期（doctor） | `session-dead` | 1 | ✓ |
| billing transport 失败 | `billing-unreachable`（单测映射，`billing/index.js:126-137`） | — | ✓ |

**缺陷 A（should-fix P1）**：**helper 已定位到二进制、但 helper 运行失败**（非零退出 / 超时 / 绑定缺失）被报成 `electron-not-found`（`src/credentials/electron.js:305-311`）。实测：`doctor --decrypt` 用存在的 `node.exe` 当假 helper 时，`electron-binary=pass` 而 `credential=fail(electron-not-found)` —— 二进制明明在，码却是「找不到」。这与 `src/errors.js:5-6` 自定的「不可解密是独立状态」冲突（上游对应码是 `encrypted-credential-unreadable`）。

**缺陷 B（should-fix）**：`status` 对 `session=expired` 返回 **`ok:true` + 退出码 0**，仅把 `session-dead` 放进 `reasonCodes`（`src/cli.js:228-229,254-285`）。数据在，但脚本只看 `ok`/`$?` 会当成成功。

**无「退化成未登录」路径**：顶层 catch（`cli.js:468-479`）为 `ok:false`+退出 1；无凭据时输出 `credential-missing` 而非 "signed out"。唯一缺口是顶层 catch 用**空 secrets** 做自检（下 SF-2）。

### 4. 桌面 auth 只读不变量 —— 判定：PASS

**静态证据**：全仓 write-capable 调用穷举 = `store.js`（ownPath / `chmodSync` ownPath+ownDir / `rmSync` ownPath+lock）、`catalog/index.js:126`（savedPath）、`paths.js:29`（ensureOwnDir，仅 ownDir）。桌面文件只经 `readFile`/`statSync`/`readdirSync`/`realpathSync`/`accessSync`；**无 rename / chmod / 临时文件落在桌面 auth 目录**。

**动态证据（我自跑）**：多次本地 helper 运行（`status`、`doctor --decrypt`、自造信封）前后，桌面 auth 文件 `mtime=1791851553`、`size=7912`、`sha256` **完全不变**；Roaming 候选目录不存在；`%APPDATA%\pi-workbuddy-connect` **始终未创建**（S3 未触发刷新 → 未落盘）。

### 5. 副本安全 —— 判定：PASS-WITH-CHANGES

- 路径 `%APPDATA%\pi-workbuddy-connect\workbuddy-auth.json`（`paths.js:14-25`），内容 `{version:1,credential}` **明文**（`document.js:76-78`），与桌面 `{account,auth}` 结构明显不同 → 不混淆；`parseOwnDocument` 拒绝其它 version。
- **Windows 实测（我跑的）**：`writeOwn` 后文件 mode=`666`、目录 mode=`666`，ACL 为**继承**（含多个 SID 与 `CodexSandboxUsers`，未收紧）。即 **`0600`/`0700` 在 Windows 完全不生效，工具没有任何 ACL 替代**。`store.js:6-7` 注释「on Windows only the directory matters」不准确；`README.md:102` 与报告 §3.7/§7 的「0600/0700」属 overclaim。**加分项**：`docs/security.md:54-72` 已如实写明「Windows 无 POSIX mode，仅等效于用户 profile ACL」。
- `.gitignore`（`:1-14`）**未覆盖** `workbuddy-auth.json` / `workbuddy-desktop*.info` / `.workbuddy*.json`，与 `docs/security.md:50` 的「covers credentials…」表述不符（副本在仓外，故当前无实际提交风险）。

### 6. 测试是否真「无网络」 —— 判定：PASS

**亲跑** `node --test`：`# tests 54 / # pass 54 / # fail 0`，`duration_ms 508`（无网络特征耗时）。
- 测试与源码无 `http|https|net|dgram|tls` import；上游测试全部注入 `fetchImpl` 假响应（`test/upstream.test.js`）；billing/catalog 用假 client 对象。
- 无真实 token：夹具 `test/support/fixtures.js` 本地 `randomBytes` 生成 secret/key，凭据串为 `fixture-*`（自造 key 已核实）。
- `test/cli.test.js` 每个子进程都带 `--no-network` 且 `APPDATA` 指向 temp 目录。
- **独立佐证**：在 net-block shim（`fetch`/`net.connect`/`dns.lookup`/`tls.connect` 全部抛错；control 已验证确实抛错）下，`status --no-network` 与 `doctor --no-network` **仍成功完成** → 本地路径零出站。

### 7. 红线合规 —— 判定：FAIL（仅归因一条，计入 must-fix）

- **推理请求**：`grep` 全仓无 `/v2/chat/completions`、无 chat/stream/SSE/probe 代码；`src` 内字符串 URL 仅 3 个上游域 + 同域企业计费 URL。✓
- **遥测 / 非上游域**：无 telemetry/analytics/sentry；`UPSTREAM_HOSTS` 白名单（`domains.js:13-17`）在发请求前校验；无其它域名。✓
- **重试风暴**：`client.send` 无 retry；429 仅分类并记录 `Retry-After`（`client.js:150-168`）。✓
- **`~/.workbuddy`**：代码 0 引用。观察到的目录 mtime 变动来自**独立运行中的 `WorkBuddy.exe`（tasklist 有 7 个进程，其 `memory/` 于 14:01 仍在写）**，与本工具无关。✓
- **MIT 归因（问题）**：`THIRD-PARTY-NOTICES.md` 命名并链接了上游（MIT，Copyright (c) 2026 Corrine Hu），但**绝对否认包含任何代码**（`:3` "no source code was copied"、`:13` "No code from this package is included"）。事实上 `buildAad`+`lengthPrefixed`（含 `allocUnsafe(4)`/`writeUInt32BE`/同一 `Buffer.concat` 序列）、helper 脚本字符串、`parseAtRestPayload`/`parseBase64` 等与上游**近似或逐字相同**；`README.md` 还承诺「如复用会在文件头保留版权与许可声明」，而 `src/` 各文件头并无上游声明。→ 声明不实，**must-fix**（细节见 MF-1）。

### 8. 报告诚实性 —— 判定：可接受

- 报告 §4 自认动作 (a) helper 5 次、(b) 计费 4 次：与代码一致——S3 唯一可达上游请求就是计费只读接口，**无推理、无重试**；`%TEMP%` 遗留的 `pwc-*.json`（时间戳 13:52–13:55，早于本次审查）佐证确有多次 status/doctor 运行，且内容全为掩码、**无 token 形状**，与披露吻合。
- 报告 §5（54/54）、§1（mtime 不变）、§3.3（grep 0 命中）、§1（掩码自检 ok）均被**独立复现**。
- 影响面：4 次 `POST /v2/billing/meter/get-user-resource`（只读、不计费），无 402/429。**结论：可接受**；但突破「授权动作各一次」属流程偏差，后续展示类命令应一律 `--no-network`。

### 9. 范围与纪律 —— 判定：PASS

- 本仓 `git status` 与审查开始时**逐字一致**；`HEAD=374e30e`（S3 无 commit / push；reflog 最近提交 12:06，早于 S3 工作）。
- `subagent-win` 工作区干净（HEAD `38f901f`）；`G:/code` 非 git 仓且未被触碰；未读写 `~/.workbuddy`；桌面 auth mtime/hash 不变；`%APPDATA%\pi-workbuddy-connect` 未创建。
- 审查者只读自证：未改任何仓内既有文件；夹具/探针全在 `%TEMP%` 下，审查结束已全部删除；本文件为任务要求的唯一新增产物。

---

## ③ must-fix / should-fix

### must-fix（2）

- **MF-1 归因声明不实（合规/诚实）**
  `THIRD-PARTY-NOTICES.md:3` / `:13` 否认复用上游代码，但 `src/credentials/at-rest.js` 与 `electron.js` 中的 AAD 构建、信封解析、helper 调用与上游近似/逐字相同；`README.md` 承诺的文件头声明缺失。
  **最小修法**：① 改述为「AAD 帧、binding 名与一次性 helper 调用是为互操作所必需的逐字协议事实，其余为独立重表达」；② 把上游 MIT 版权 + 许可声明原文附入 `THIRD-PARTY-NOTICES.md`（或在 `at-rest.js`/`electron.js` 文件头加注），兑现 README 承诺。依据 plan §1.6。

- **MF-2 helper 运行失败原因码错配**
  `src/credentials/electron.js:305-311` 把「二进制已解析、helper 运行失败（非零退出/超时）」报成 `electron-not-found`；`doctor` 自身显示 `electron-binary=pass`。
  **最小修法**：`loadAtRestPayload` 的 reject 改 `REASON.credentialUndecryptable`（或新增 `electron-helper-failed`）；`electron-not-found` 仅留在 `resolveElectronBinary` 的解析失败路径。

### should-fix

- **SF-1 `status` 死会话静默成功**：`cli.js:228-229` 时 `ok:false`（或退出非零），或明确定义并文档化 `ok` 语义为「凭据已解析」。最小修法：`session.state==='expired'` → `ok:false`。
- **SF-2 顶层自检空 secrets**：`cli.js:476` 传 `[]`；把已收集 secrets 透传（或在 `buildStatus/buildDoctor` 内先收集）。
- **SF-3 Windows 权限 overclaim**：`README.md:102`、`store.js:6-7`、报告 §3.7/§7 的 `0600/0700` 在 Windows 不成立（实测 666 + 继承 ACL）。与 `docs/security.md:54-72` 对齐表述。
- **SF-4 `.gitignore` 未覆盖凭据名**：追加 `workbuddy-desktop*.info`、`workbuddy-auth.json`、`workbuddy-ai-auth.json`、`.workbuddy*.json`。
- **SF-5 公开文档含真实掩码样本**：`README.md:86-91` 与报告示例换成 `test/support/fixtures.js` 式自造值。
- **SF-6 自留副本为明文凭据**（`document.js:76-78`）：文档明示，或 M2 用同一 at-rest key 加密 / OS keychain（承接研究 R6）。
- **SF-7（可选）`readOwn` 吞掉所有读错误**（`store.js:17-26`）：区分 `ENOENT` 与其它错误并上报 `credential-unreadable`。

---

## ④ 报告诚实性的独立结论

**可接受**。报告的实质主张——解密成立、余额读到、桌面只读、54/54 无网络、无推理/遥测/重试——均被独立复现；对「授权动作超次」的自我披露与代码可达面一致，且遗留 temp 文件佐证计数方向正确、内容全掩码。结论：**不是粉饰**；但「各只做一次」的约束被突破属流程偏差，未来展示类命令应默认 `--no-network`。

---

## ⑤ 能否放行进 S1

**修完 MF-1、MF-2 后放行。** 功能与安全不变量（解密正确、fail-closed、桌面只读、无推理/遥测/重试、测试零网络）已由独立证据坐实，无阻断性功能缺陷；SF-1/3/5 建议同批修，SF-2/4/6/7 可纳入 S1 backlog。在 MF 未修前，判定为 **PASS-WITH-CHANGES（暂不放行）**。
