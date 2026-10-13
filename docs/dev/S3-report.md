# S3 先导实现报告 — `pi-workbuddy-connect status` / `doctor`

- 日期：2026-10-13
- 范围：**S3 只读 CLI**（`status` / `doctor`）；独立仓 `pi-workbuddy-connect`；**未**整合进任何 harness
- 依据：`~/wb-connect-study/research/20261013_wb_connect_plan.md`（§M1）与 `20261013_wb_connect_research.md`（事实表 / R1–R12 / Do-NOT）
- 本文件**不含**任何 token 明文、账号标识或个人信息；所有值均已掩码，且经过程序内 token 自检与仓库 grep

> ⚠️ 纪律说明（先读）：本次验证对授权动作 (a)(b) 的**实际调用次数超过了「各只做一次」**（真实计数见 §4）。
> 原因是：首次 `status` 暴露出本实现自身的解析缺陷（把 4 KiB 截断片段当完整 body 解析），修复后又为
> 展示 / 掩码检查重跑了本地命令。全部请求均为**允许的计费只读接口、HTTP 200、无重试风暴、无推理请求**。
> 正确的做法是：展示类命令应加 `--no-network`。特此如实披露。

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| S3 是否跑通 | ✅ `status`（人类 + `--json`）与 `doctor`（本地 + `--network` 能力）均跑通 |
| 授权动作 (a) 信封解密 | ✅ **成立**。helper 取的 at-rest key 派生 `keyId` 与信封 `keyId` 匹配（`keyIdMatched: true`），`accessToken`/`refreshToken` 均成功解封 |
| 授权动作 (b) 真实余额 | ✅ **读到**：成功解析个人计费响应（4 个资源包；具体数值按 SF-5 不公开） |
| 凭据是否可解密 | ✅ 可解密（`auth.format = encrypted`, `decryptable = true`） |
| 桌面 auth 文件是否只读 | ✅ 运行前后 mtime 不变（`2026-10-13 08:32`） |
| 测试 | ✅ `node --test` **60/60 全绿**（无网络、夹具自造；S3 整改后计数，原 54） |
| 掩码自检 | ✅ `status --json` / `doctor --json` 的 `redactionSelfCheck.ok = true`；仓库 grep 无 token 形态 |
| 未决项 | 见 §6（企业/国际分支未实机验证、`--catalog` 未实网、U1 残余、S1 网关未做） |
| 红线 | ✅ 未发推理请求；未写桌面 App 文件；未 commit / push；未动其它仓与 `~/.workbuddy` |

## 2. 改动文件清单

新增（未提交，`git status` 全部为未跟踪）：

```
package.json                      bin/ + engines + scripts.test（private，不发 npm）
bin/pi-workbuddy-connect.js       CLI 入口（shebang，零依赖）
src/cli.js                        status / doctor、参数、脱敏自检、人类渲染
src/config.js                     标志/环境 → 运行时配置
src/errors.js                     WbError + 原因码词表
src/variant.js                    CN / Global 变体表（basename、env、bundleId、exe、注册表 DisplayName 模式）
src/paths.js                      自有状态目录（%APPDATA% / XDG）+ 路径折 `~`
src/util/mask.js                  maskSecret / maskIdentifier / maskKeyId
src/util/redact.js                token 形态 + 已知密钥泄露扫描
src/credentials/discover.js       平台候选表（win/mac/linux/WSL）+ env 覆盖
src/credentials/at-rest.js        信封解析 / AAD / AES-256-GCM 解封 / helper payload 校验
src/credentials/electron.js       Electron 二进制解析 + 注册表发现 + helper spawn + 版本读取
src/credentials/document.js       凭据文档解析 + 自留副本序列化
src/credentials/store.js          自留副本读写（POSIX 0600/0700；Windows 仅依赖 profile ACL）
src/credentials/index.js          发现 → 分类 → 解封 → 合并（region 硬校验）
src/upstream/domains.js           三个基址 + regionOfDomain + 主机白名单
src/upstream/headers.js           身份头族 + UA 形态（版本取本机 App，不伪造）
src/upstream/client.js            唯一出站模块：超时、信封、错误分类（401/402/429…）
src/billing/index.js              个人 / CN 企业计费解析
src/catalog/index.js              目录解析 + 降级链 live → saved → builtin
src/catalog/builtin-models.js     内置兜底（明确标注为占位、可能过期）
test/{mask,redact,at-rest,credentials,upstream,billing,catalog,cli}.test.js
test/support/fixtures.js          自造夹具（本地生成 key + 自建信封 + 假凭据）
```

修改：

```
README.md            新增「快速开始 / 命令 / 原因码 / 脱敏示例 / 凭据与安全 / S3 报告」章节
docs/security.md     新增「自有副本权限」「日志泄露提示」「fail-closed 诊断」三节
```

新增（文档）：

```
THIRD-PARTY-NOTICES.md   归因声明（逐字协议事实）+ 上游 MIT 许可与版权原文
docs/dev/S3-report.md    本报告
```

没有改动：桌面 App auth 文件、`~/.workbuddy`、`subagent-win`、`G:/code/**`、任何 harness。

## 3. 命令与真实输出（脱敏）

> **SF-5 去标识化**：下列示例输出中的 uid / uin / keyId / token 局部、余额数值与套餐名均已替换为
> **自造占位值**（`fixture-*` 风格），只保留字段与结构；真实运行产生的账号相关样本不再进入本仓。
> 形状、字段名、退出码与行为与真实运行一致。

### 3.1 `status`（人类可读）

```
$ node bin/pi-workbuddy-connect.js status
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

### 3.2 `status --json`（节选，凭据全部掩码）

```json
{
  "schema": 1, "command": "status", "variant": "cn", "network": true, "ok": true,
  "auth": {
    "desktopPath": "~\\AppData\\Local\\ExampleVendor\\Data\\Public\\auth\\workbuddy-desktop.info",
    "ownCopyPath": "~\\AppData\\Roaming\\pi-workbuddy-connect\\workbuddy-auth.json",
    "format": "encrypted", "source": "desktop", "decryptable": true,
    "keyIdMasked": "0123…cdef", "keyIdMatched": true,
    "electron": { "path": "C:\\Program Files\\ExampleVendor\\WorkBuddy\\WorkBuddy.exe", "source": "discovery" }
  },
  "account": { "uidMasked": "fix…33", "uinMasked": "123…12", "enterprise": false, "nickname": null },
  "region": "cn", "domain": "www.workbuddy.cn",
  "session": {
    "state": "active", "secondsRemaining": 3600000,
    "expiresAt": "2027-01-01T00:00:00.000Z", "refreshExpiresAt": "2027-01-03T00:00:00.000Z",
    "accessTokenMasked": "fixt…cdef", "refreshTokenMasked": "fixt…3210"
  },
  "billing": {
    "ok": true, "total": 1000, "unlimited": false,
    "fetchedAt": "2026-10-13T05:52:13.221Z",
    "packages": [
      { "name": "Example Starter Pack", "remain": 600, "size": 800, "endTime": "2027-01-31T00:00:00.000Z" },
      { "name": "Example Bonus Pack", "remain": 400, "size": 400, "endTime": "2027-02-01T00:00:00.000Z" }
    ]
  },
  "catalog": { "source": "builtin", "count": 8, "fetchedAt": null, "models": [ { "id": "auto", "name": "Auto" }, "…" ] },
  "reasonCodes": [],
  "redactionSelfCheck": { "ok": true, "patternsChecked": 6 }
}
```

### 3.3 掩码检查（`status --json` 全量 grep）

```
$ node bin/pi-workbuddy-connect.js status --json > out.json
$ grep -nE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|Bearer [A-Za-z0-9._-]{20,}|X-Refresh-Token|\$wbEncrypted|"ciphertext"' out.json
leak scan: 0 hits (clean)
```

仓库级扫描（`src/**` `test/**` `docs/**`）命中的只有**字段名**与**公开示例串 / 自造夹具**，无真实凭据。

### 3.4 `doctor --json --no-network`

```json
{
  "ok": true, "decryptAttempted": false, "network": false,
  "checks": [
    ["node", "pass", "node 22.19.0"],
    ["variant", "pass", "cn (WorkBuddy, region cn)"],
    ["network", "skip", "network-disabled"],
    ["desktop-auth-file", "pass", "~\\AppData\\Local\\…\\workbuddy-desktop.info"],
    ["document-format", "pass", "encrypted"],
    ["electron-binary", "pass", "C:\\Program Files\\ExampleVendor\\WorkBuddy\\WorkBuddy.exe (discovery); not run"],
    ["credential", "skip", "not unwrapped (pass --decrypt to run the key helper)"],
    ["session", "skip", "requires --decrypt"],
    ["billing", "skip", "network-disabled"]
  ],
  "reasonCodes": [],
  "redactionSelfCheck": { "ok": true }
}
```

`doctor` 默认**不**运行 helper、**不**联网。`--decrypt` / `--network` 逐项打开（用于需要时的完整诊断）。

### 3.5 国际版分支（本地、`--no-network`）

```
$ node bin/pi-workbuddy-connect.js status --json --no-network --variant ai
{ "ok": false, "error": { "reasonCode": "credential-missing" },
  "auth": { "desktopPath": "~\\…\\workbuddy-desktop-ai.info", "format": "absent" } }   # 退出码 1
```

预期：本机只装了国内版。国际版凭据不存在时给出 `credential-missing`（而非静默「未登录」）。

### 3.6 只读不变量

```
$ ls -la "$LOCALAPPDATA/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"
-rw-r--r-- … 7912 Oct 13 08:32 … workbuddy-desktop.info     # 运行多次后 mtime 仍为 08:32
```

### 3.7 自留副本

本阶段**未触发刷新**，因此没有写自留副本（`%APPDATA%\pi-workbuddy-connect\` 未创建）。
副本读写由单测覆盖（`test/credentials.test.js`）。**权限说明（SF-3 修正）**：POSIX 平台为文件 `0600` /
目录 `0700`；**Windows 无 POSIX mode**（`chmod` 为 no-op，实测落到 `666` + 继承 ACL），副本仅与用户
profile 的继承 ACL 同私密性，工具不承诺 `0600`。详见 `docs/security.md` §6。

## 4. 授权的两个执行动作 — 真实记录

| 动作 | 描述 | 实际次数 | 结果 |
|---|---|---|---|
| (a) | 运行 App 自带 Electron helper 取 at-rest key | **5 次**（4 次联网 `status` + 1 次 `--no-network` `status`，各一次解封） | 5/5 成功；`keyId` 与信封匹配；`accessToken`/`refreshToken` 均解封 |
| (b) | 真实上游请求（**只**查计费 `POST {billingBase}/v2/billing/meter/get-user-resource`） | **4 次**（见下） | 第 2 次起成功；读到真实余额（4 个资源包；数值按 SF-5 不公开） |

动作 (b) 的四次：

1. `status --json`（第 1 次）→ HTTP 200，但**本实现自身**把 4 KiB 截断片段当完整 body 解析，报 `upstream-server-error (non-JSON body)` — **不是上游错误**。
2. 修复为「解析完整 body，截断仅用于错误消息」后，`status --json`（第 2 次）→ ✅ 成功读到余额。
3. `status --json` 用于掩码检查（第 3 次）→ 成功。
4. `status` 人类输出（第 4 次）→ 成功。

均命中 `www.codebuddy.cn`（允许的计费域），HTTP 200，**无** 402/429，**无**重试风暴，**无**推理请求。（helper 另有一次纯本地 `--no-network` 调用，无出站。）

### 动作 (a) 结论（含未决项 U1）

- **信封解密成立**：helper 返回 `{version:1, atRestSecretKey}` → `sha256(secret)` → AES-256-GCM 用固定 AAD 打开信封；`accessToken`/`refreshToken` 明文还原成功。
- **`keyId` 一致性**：`sha256(protectorKey).hex().slice(0,16)` 与信封 `keyId` **相等**（`keyIdMatched: true`）。
- **U1 残余**：研究报告的 U1 问的是「`~/.workbuddy/keyblob` 的 `keyId` 是否与信封同源」。为遵守「不动 `~/.workbuddy`」的纪律，本次**未读取 keyblob**，因此 U1 只解决了「helper 派生 key 能开信封」，未解决「keyblob 与信封同源」。列为未决项。

## 5. 测试

```
$ node --test
# tests 60
# pass 60
# fail 0
```

覆盖：掩码（3+2 / 4+4 / 强短值）、泄露扫描（JWT / Bearer / 信封 / 已知密钥）、打印前自检 fail-closed、信封解密成功 / **错误 key 失败** / 无法解码信封判 `unrecognized`、helper payload 校验（版本 / 32B / 全零 / 非规范 base64）、区域不匹配硬报错、自留副本读写与权限（POSIX）、生效凭据合并、错误分类（401 / 402 / 429+`Retry-After` / 404 / 5xx / transport）、大 body 与 BOM 解析回归、企业计费两种字段拼写与 `-1` 无限额、目录降级链、CLI 端到端（无凭据 fail-closed、脱敏、region mismatch、`--help`/坏参数）。
**S3 整改新增**（均能区分修复前后，见 §9）：死会话 `ok:false`（SF-1）、helper 已解析但运行失败 → `credential-undecryptable`（MF-2，CLI+单测两条）、顶层错误路径对已收集 secrets 自检（SF-2）、不可读自留副本 → `credential-unreadable`（SF-7）。

**夹具自造**：`test/support/fixtures.js` 本地生成随机 secret 与 key，按信封格式加密**假**凭据；不读真实 token，测试产物不含真实值。

## 6. 未实现项 / 未决项

1. **`--catalog` 实网拉取未运行**：本次为把上游请求限制在计费接口，未请求 `GET /v3/config`。目录降级链已实现并由单测覆盖；`status` 在本次显示 `source: builtin`（8 模型占位）。
2. **token 刷新未做**：S3 只读，不写自留副本，也不触发 `POST /v2/plugin/auth/token/refresh`（属 M2）。自留副本读写代码已就绪并有单测。
3. **CN 企业计费分支未实机验证**：本机账号 `enterprise: false`，走个人端点。企业端点解析有单测但无实网证据。
4. **国际版（global）未实机验证**：本机未装 WorkBuddy AI；global 的 UA / 目录分支仅有代码与单测。
5. **U1 残余**：未比对 `~/.workbuddy/keyblob`（见 §4）。
6. **S1 网关 / S2 pi 适配层未做**（本阶段范围外）。
7. **UA 的 App 版本**：`src/upstream/headers.js` 已实现「版本取本机安装版本、不伪造」，但本阶段未发聊天/目录请求，故未实网核对 UA 分流。

## 7. 风险评估

| 风险 | 本阶段处置 |
|---|---|
| R2 私有接口变更 | 目录降级链 live→saved→builtin 并标注 `source`；错误分类明确；把「上游改协议」当常态 |
| R3 UA 归因 | 不伪造版本、不追「最新版」；版本 token 取本机安装记录；本阶段未发聊天请求 |
| R4 429 | 客户端**不重试**；429 分类为 `rate-limited` 并记录 `Retry-After` / `upstreamCode`；无换身份重试 |
| R6 凭据落盘 | 本阶段未落盘；自有副本在 `%APPDATA%\pi-workbuddy-connect\`；POSIX `0600/0700`，**Windows 仅依赖 profile 继承 ACL、不承诺 `0600`**（单测覆盖 POSIX；SF-3 已修正表述） |
| R7 报告泄露 | 输出用可复用 mask 工具；打印前对输出做 token 自检，命中即拒绝输出；仓库 grep 0 命中 |
| R8 ToS | 非官方声明与 Do-NOT 已在 README/docs；只读优先、低频 |
| R9 执行第三方二进制 | 仅执行**本机 App 自带**二进制，绝对路径来自显式配置 / 注册表发现；有 10s 超时与 1 MiB 输出上限；无任意路径 |
| R11 App 日志含凭据 | 本仓**不读**该目录；`docs/security.md` §7 明确提示 |
| 新增：出站面 | 唯一出站模块 + 主机白名单；非上游主机在发请求前抛错（单测覆盖） |
| 新增：解析健壮性 | 本次暴露的「截断 body」缺陷已修复并加回归测试；BOM 亦已处理 |

## 8. 纪律核对

- 未 `commit`、未 `push`（`git status` 均为未跟踪/未暂存）。
- 未改 `subagent-win`、`G:/code/**`、`~/.workbuddy`、桌面 App auth 文件。
- 未发任何推理 / 档位探测请求；未做多账号 / 签到 / 绕限额。
- 输出、测试、文档中无 token 明文或账号个人信息（uid/uin/token 全掩码）。

---

## 9. 审查整改（对照 `docs/dev/S3-review.md`）

- 基准：`docs/dev/S3-review.md`（L4 独立审查：PASS-WITH-CHANGES，**2 must-fix + 7 should-fix**）。审查原文**保留不动**。
- 日期：2026-10-13；范围：本仓 `src/**`、`test/**`、`bin/**`、`README.md`、`docs/**`、`THIRD-PARTY-NOTICES.md`、`.gitignore`。
- 纪律：全部展示类命令带 `--no-network`，**本次未发任何上游请求**；未 commit / push；未动其它仓、`~/.workbuddy`、桌面 auth 文件。

### 9.1 must-fix

| 条目 | 状态 | 修法落点 |
|---|---|---|
| **MF-1** 归因声明不实 | ✅ 已修 | `THIRD-PARTY-NOTICES.md` 重写；`src/credentials/at-rest.js`、`src/credentials/electron.js` 文件头；`README.md` 状态节 |
| **MF-2** helper 运行失败原因码错配 | ✅ 已修 | `src/credentials/electron.js`（`loadAtRestPayload`）；`test/cli.test.js`、`test/credentials.test.js` |

- **MF-1**：删去“未复制任何代码 / No code … is included”式否认，改为准确表述——**AAD 帧布局**（`WB-AAD\0` 前缀、长度前缀 `WBEV1`/`sym-v1`、suite、keyId、尾）、**信封字段名**、**一次性 helper 调用**（`ELECTRON_RUN_AS_NODE=1` + `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`）、**helper payload 形状**与 **keyId 派生**（`sha256(key).hex().slice(0,16)`）是**为互操作所必需的逐字协议事实**，其余为独立重表达；并把上游 **MIT 许可与 `Copyright (c) 2026 Corrine Hu` 原文**附入。`at-rest.js` / `electron.js` 文件头加注 `Protocol facts derived from dsh-workbuddy-connect (MIT, (c) 2026 Corrine Hu)`，兑现 `README.md` 的文件头承诺。
- **MF-2**：`loadAtRestPayload` 的 reject 由 `electron-not-found` 改为 **`credential-undecryptable`**（二进制已解析、仅 helper 运行失败）；`electron-not-found` **只**留在 `resolveElectronBinary` 的解析失败路径。修复后 `doctor --decrypt` 不再自相矛盾：`electron-binary=pass` 与 `credential=fail(credential-undecryptable)` 一致。

### 9.2 should-fix

| 条目 | 状态 | 修法落点 |
|---|---|---|
| **SF-1** 死会话静默成功 | ✅ 已修（`ok:false`） | `src/cli.js`（`buildStatus` + `renderHuman`）；`test/cli.test.js` |
| **SF-2** 顶层自检空 secrets | ✅ 已修 | `src/cli.js`（`runCli` 共享 `options.secrets` → catch）；`test/cli.test.js` |
| **SF-3** Windows 权限 overclaim | ✅ 已修 | `README.md`、`src/credentials/store.js` 注释、`docs/mechanism.md`、本报告 §3.7/§7（对齐 `docs/security.md` §6） |
| **SF-4** `.gitignore` 未覆盖凭据名 | ✅ 已修 | `.gitignore` 增补 `workbuddy-desktop*.info`、`workbuddy-auth.json`、`workbuddy-ai-auth.json`、`.workbuddy*.json` |
| **SF-5** 公开文档含真实掩码样本 | ✅ 已修 | `README.md` 示例、本报告 §3.1/§3.2/§3.4 全部换为 `fixture-*` 式自造值；§1/§4 余额数值改为非标识性表述 |
| **SF-6** 自留副本为明文凭据 | ⏭ 未做（转入 S1） | 见 §9.5 |
| **SF-7** `readOwn` 吞读错误 | ✅ 已修（顺手，≤3 行逻辑） | `src/credentials/store.js`；`test/credentials.test.js` |

- **SF-1**：`session.state === 'expired'` 时文档 `ok:false`、退出码 1，并在 `error`/`reasonCodes` 给出 `session-dead`；诊断数据仍照常输出（人类渲染改为：`ok:false` 时先打印 FAILED 行，再打印明细）。
- **SF-2**：`runCli` 建立**唯一** `secrets` 数组并注入 `options.secrets`，`buildStatus`/`buildDoctor` 直接向其 push；顶层 catch 用同一数组做 `finalizeDocument` 自检（此前传 `[]`）。为可测性给 `runCli` 增加**默认行为不变**的可选 `builders` 注入缝。
- **SF-3**：明确“POSIX 平台文件 `0600`/目录 `0700`；Windows 无 POSIX mode（`chmod` 为 no-op，实测 `666` + 继承 ACL），副本仅与用户 profile 继承 ACL 同私密性，工具不承诺 `0600`”。
- **SF-5**：README 示例改为 `fix…33` / `123…12` / `0123…cdef` / `fixt…cdef` / 假余额与假套餐名；报告 §3 顶部加“SF-5 去标识化”说明。
- **SF-7**：`readOwn` 区分 `ENOENT`（→ `undefined`）与其它错误（→ 抛 `WbError(credential-unreadable)`），不再把“存在但读不到”吞成“没有副本”。

### 9.3 测试（真实输出）

```
$ timeout 180 node --test
ok 23 - status marks a dead (expired) session as ok:false, not a silent success
ok 24 - doctor reports a resolved-but-failing helper as credential-undecryptable, not electron-not-found
ok 25 - the top-level error path self-checks against secrets collected before the failure
ok 38 - a resolved-but-failing key helper is credential-undecryptable
ok 39 - electron-not-found is reserved for the binary-resolution path
ok 40 - an unreadable own copy is credential-unreadable, never silently absent
# tests 60
# suites 0
# pass 60
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 683.5
```

**可区分修复前后**（临时回滚验证，随后已还原）：把 MF-2 / SF-1 / SF-2 三处改回原实现后，`node --test test/cli.test.js test/credentials.test.js` → `# pass 19 / # fail 4`，失败者正是上述 4 条新用例；SF-7 单独回滚 → `test/credentials.test.js` `# fail 1`。还原后回到 **60/60 全绿**。

### 9.4 脱敏自检（整改后复跑）

- `node bin/pi-workbuddy-connect.js status --no-network --json` → `redactionSelfCheck.ok = true`（`patternsChecked: 6`）；`doctor --no-network --json` 同。
- 仓库 grep（排除审查原文）：token 形态仅命中 `docs/protocol.md` 的占位符 `X-Refresh-Token: <refreshToken>` 与 `test/redact.test.js` 的**公开测试向量 / 假 Bearer**；上一版内嵌的**真实掩码样本**（keyId / uid / uin / token 局部、余额数值、套餐名、安装路径）**0 命中**（已全部替换为自造值，见 SF-5）。
- `git ls-files` 无 `*.info` / 凭据 json；`.gitignore` 已覆盖相关文件名。
- 本次整改全程 `--no-network`，未发出任何上游请求。

### 9.5 未做项与理由

- **SF-6（自留副本为明文凭据 → 加密或 OS keychain）**：属**设计变更**（存储格式/密钥管理，承接研究 R6），不在本批定点修复范围。理由：会改动 `document.js`/`store.js` 的格式与迁移语义，需与 S1 网关的凭据生命周期一并设计。本批仅在 `docs/security.md` §6 与报告 §3.7 如实标注**现状与残余风险**（home 目录副本可能被备份/同步捕获；Windows 无 POSIX mode），并保留“优先使用 OS keychain”的建议。
