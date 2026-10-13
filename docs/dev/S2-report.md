# S2 实现报告 — 把本地反代接入 pi 模型体系（`models.json` 自动生成 provider）

- 日期：2026-10-13
- 范围：**S2**（`install-provider` / `uninstall-provider`、命名对齐、subagent-win 使用方式）+ 一次**真机实测**
- 基线：`HEAD = 6d8b992`；本仓 `C:/Users/Annacomnena/pi-packages/pi-workbuddy-connect`，分支 `main`
- 计划：`docs/dev/1013_S2-models-provider.md`
- **未 commit、未 push、未发 npm**；未动 `G:/code/**`、`subagent-win` 源码、`~/.workbuddy`、桌面 auth 文件
- **未启动 `serve`、未发任何上游推理请求**（模型列表来自本仓缓存；验证只用 pi 的只读命令与动态导入）
- 本文件不含 token/账号明文：所有密钥一律掩码（如 `6jxe…_m1U`），`models.json` 里的 apiKey 用占位符说明

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| 命名方案 | 选 **(a)**：网关 `/v1/models` 的 `id` 改为**上游裸 id**，旧 `workbuddy/<id>` 作为别名保留（请求侧本来就双向接受，另加 `workbuddy_prefixed_id` 字段）。pi 侧 provider key = `workbuddy`，于是 **`/v1/models` 的 id ≡ `models.json` 的 id ≡ 请求体 model ≡ 上游 id**，模型引用稳定为 `workbuddy/<id>` |
| 实测能否被 pi 解析 | ✅ 真机：`pi --offline --list-models workbuddy` 列出 **18** 行；`pi --offline --list-models workbuddy/glm-5.3` 命中；全量模型 41 → **59** 行。另用 pi 自己的 `ModelConfig.load()` + `findExactModelReferenceMatch()` 验证 schema 无错、`workbuddy/glm-5.3` 精确解析（见 §6.3） |
| 命令 | `install-provider [--dry-run] [--json] [--port N] [--models-json P] [--api-key-env NAME]`、`uninstall-provider [--dry-run] [--json] [--models-json P]` |
| 幂等 | ✅ 真机实测：`install-provider` 连跑两次，第二次 `changed:false`、文件 sha256 **完全不变**、不新增备份 |
| 备份 | ✅ 真机实测：写入前备份到 `~/.pi/agent/config-backups/models.json.<UTC 毫秒时间戳>.bak`（同名时自动 `-2`/`-3` 递增，不覆盖） |
| 不破坏其它 provider | ✅ **字节级**证明：写入后文件的「我们那段之前的全部字节」与备份逐字节相同；uninstall 后 sha256 回到写入前的原值（`0d8e08…`），reinstall 后回到同一安装值（`007ca5…`） |
| 离线 | ✅ 命令**完全不联网**、不运行 App 密钥 helper：目录取 `%APPDATA%/pi-workbuddy-connect/workbuddy-catalog.json`（`status --catalog` 刷新），无缓存则用内置占位表并告警 |
| 测试 | ✅ `node --test` **150/150 全绿**（新增 22 个 S2 用例） |
| 已知真机问题 | 本机 `renameSync` 覆盖 `models.json` 报 `EPERM`（有进程占用该文件）→ 已实现**原子失败即原地写**的降级路径，并在文档/输出里说明（§7.5） |

---

## 2. 侦察事实（实现依据，均为读源码得到）

| # | 事实 | 位置 |
|---|---|---|
| F1 | pi 在**第一个 `/`** 处切 `provider/id`；规范比较是 `${provider}/${id}` 全等；provider 段和 id 段分别精确匹配 | `pi-coding-agent/dist/core/model-resolver.js` `findExactModelReferenceMatch` |
| F2 | 自定义 provider 只能来自 `models.json` 的 `providers.<key>`；`api` 与 `baseUrl` 必需（provider 级或 model 级） | `dist/core/provider-composer.js` `modelFromJson` |
| F3 | `models.json` 是**严格 schema**（TypeBox，`additionalProperties` 未置 true ⇒ 关闭）：出现未列举的键 → **整份文件被拒**，报 `Invalid models.json schema`，且**所有** provider 都不加载 | `dist/core/model-config.js` `ModelConfig.load` |
| F4 | `apiKey` 支持字面量 / `$NAME`、`${NAME}` 插值 / `!command` | `docs/models.md` |
| F5 | 路径 = `${PI_CODING_AGENT_DIR:-~/.pi}/agent/models.json`（`APP_NAME=pi`） | `dist/config.js` `getAgentDir()` / `getModelsPath()` |
| F6 | `compat` 是 provider 级与 model 级**逐键浅合并**；键集受 schema 限制 | `provider-composer.js` `mergeCompat` |
| F7 | 本机 `models.json`：21 个 provider、**CRLF**、2 空格缩进、短数组有的内联有的展开 ⇒ 不是 `JSON.stringify(...,2)` 的输出；naive 重写会改动 291 行 | 实测（round-trip identical = false） |
| F8 | subagent-win 的 `model` 参数：含 `/` 的原样透传；短名从 `~/.pi/agent/models.json` + `~/.pi/models.json` 的 `providers[].models[]` 展开，**唯一匹配才展开，多匹配抛 `Ambiguous model alias`** | `subagent-win/extensions/index.ts` `normalizeModelRef`（只读引用） |
| F9 | pi 的只读校验命令 `pi --offline --list-models [search]` 不发推理请求 | `pi --help` |
| F10 | 网关原 `/v1/models` 广告 `workbuddy/<id>`；请求侧 `stripModelPrefix` 双向接受 | `src/gateway/openai.js`、`src/protocol/body.js` |

---

## 3. 命名对齐：为什么选 (a)

**目标形式来自用户口径**：`model: workbuddy/glm-5.3`。由 F1，这**要求 pi 的 provider key 必须是 `workbuddy`**。

- **排除 (b)**（provider 取别的名字）：无论模型 id 怎么写，引用都会变成 `别的名/...`（若照抄网关 id 还会得到 `wb/workbuddy/glm-5.3`），**不满足用户要的 `workbuddy/<id>`**。
- **provider key = `workbuddy` 后**，`models.json` 的 `models[].id` **必须**是裸 id（`glm-5.3`），否则 pi 引用会变成 `workbuddy/workbuddy/glm-5.3` —— 这正是"双前缀陷阱"。
- 因此把 `/v1/models` 的规范 `id` 也改成裸 id：**四层同一个字符串**
  `GET /v1/models 的 id` ≡ `models.json 的 id` ≡ 请求体里的 `model` ≡ 上游 id；而用户的 `model:` 写法 `workbuddy/<id>` 恰好等于网关的 `provider/id` 拼法。
- **旧前缀没有丢**：
  1. 请求侧 `stripModelPrefix` 不变 ⇒ 已经配好 `workbuddy/<id>` 的客户端（含 README 里原来的 curl 示例）继续可用；
  2. 每条模型新增非标准字段 `workbuddy_prefixed_id: "workbuddy/<id>"`，列表级新增 `workbuddy_id_style: "bare"`，旧拼写仍可被发现；
  3. install-provider 另有防御：目录里若仍带 `workbuddy/` 前缀（旧网关/旧缓存），生成时**规范化去掉**（`canonicalModelId`），并去重。

测试里有一条把三者钉在一起的断言（`test/provider-install.test.js`）：
`advertised.data[0].id === entry.models[0].id`、`modelReference(id) === 'workbuddy/glm-5.3'`、`workbuddy_prefixed_id === modelReference(id)`。

### 兼容性影响

| 面 | 影响 |
|---|---|
| 推理请求 | **无**：裸 id 与前缀 id 都照常工作（前缀被剥离） |
| `/v1/models` 读 id 的客户端 | id 字符串变了（`workbuddy/hy3` → `hy3`），但**发送旧 id 仍然有效**；因此只是"显示变化"，不是破坏 |
| 本仓文档/测试 | `docs/protocol.md`、`test/gateway.test.js`、`test/protocol-body.test.js` 已同步（S1 报告是历史记录，未改写） |

---

## 4. 改动清单

### 新增

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/provider/models-json.js` | 486 | JSON 感知扫描器（返回**偏移**而非值）+ **字节级拼接**（`spliceProvider` / `spliceProviderRemoval`）+ 按文件自身风格渲染（CRLF/缩进/内联短数组）+ 条目构造/校验 + `assertSpliceSafe`（写前自检）+ `lineDiff` |
| `src/provider/install.js` | 361 | `install-provider` / `uninstall-provider`：路径解析（`--models-json` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`）、备份、写入（原子→原地降级）、离线目录获取、密钥样式、文档输出 |
| `test/provider-install.test.js` | 474 | 22 个用例（见 §5） |
| `docs/dev/1013_S2-models-provider.md` | — | 本阶段计划（事实依据 + 步骤） |

### 修改

| 文件 | 关键落点 |
|---|---|
| `src/gateway/openai.js` | `modelList()`：`id` = 裸 id；新增 `workbuddy_prefixed_id`、列表级 `workbuddy_id_style: 'bare'` |
| `src/cli.js` | 两个新命令、`--dry-run` / `--api-key-env` / `--models-json` 解析、USAGE、`renderHuman` 两个分支（含失败文档分支） |
| `src/config.js` | `dryRun` / `apiKeyEnv` / `modelsJsonPath` 透传 |
| `src/errors.js` | 新原因码 `models-json-unreadable` |
| `src/gateway/server.js` | 头注释同步 |
| `test/gateway.test.js` | `/v1/models` 断言改为裸 id + 别名 |
| `docs/protocol.md` | id 形态 + 别名 + 前缀双向接受 |
| `README.md` | 新增「接入 pi / subagent-win（S2）」一节（命令语义表、示例、前提、故障排查）；路由表 id 说明；文件地图；状态行 |

---

## 5. 测试（`node --test`，真机输出）

```
1..150
# tests 150
# suites 0
# pass 150
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9819.8396
```

新增用例覆盖（`test/provider-install.test.js`，22 个）：

| 用例 | 断言要点 |
|---|---|
| 命名对齐 | provider key = `workbuddy`；裸 id；旧前缀被规范化；**三层一致性断言** |
| 别名去重 | `hy3` 与 `workbuddy/hy3` 同时出现时收敛成一条 |
| 条目键集 | 生成的 provider/model/compat/cost 键均在 pi 允许集内；未知键被拒（防 F3 整份文件被拒） |
| dry-run | **不落盘**、**不备份**、`diff` 含 `+`、diff 与整个 JSON 文档里**都没有密钥明文**（并用 `finalizeDocument` 走一遍 CLI 自检） |
| 写入 | 其它 provider **子串逐字节存在**（`alpha`/`beta` 各自原文）、键序 `['alpha','beta','workbuddy']`、CRLF 保持、尾行保持 |
| 备份 | 备份内容 == 原文件字节；`document.backup` 指向该文件 |
| 幂等 | 第二次 `changed:false`、`diff:''`、文件字节不变、备份数不变 |
| 新建/空对象 | 文件不存在时创建；`"providers": {}` 内联空对象被展开成正常缩进；无 `providers` 键时补上 |
| fail closed | JSONC（`//` 注释）与非 JSON → `models-json-unreadable`，文件不变、无备份 |
| 密钥样式 | 默认字面量 == `gateway.json` 的 token；`WORKBUDDY_GATEWAY_TOKEN` 存在 → `$WORKBUDDY_GATEWAY_TOKEN` 且不落盘；`--api-key-env` → `$NAME` |
| 占位目录 | 无缓存 → `catalog.source === 'builtin'` + 显式 warning |
| 目录为空/过旧 | 空目录 → 以 `catalog-unreachable` 拒绝且不写文件；缓存 >7 天 → warning |
| uninstall | 只删我们那段；**install + uninstall 回到原始字节**；重复 uninstall `changed:false`；首位成员删除也保持其余原文 |
| dry-run uninstall | 只出 diff，文件不变、备份不增 |
| pi 自身校验 | 动态 import pi 的 `ModelConfig.load()`：**无 schema 错误**、provider id 列表含 `workbuddy`、模型 id 正确（pi 未安装时 `t.skip`） |
| 路径解析 | `--models-json` > `PI_CODING_AGENT_DIR`（含 `~` 展开）> 默认 |
| diff 与比较工具 | `lineDiff` 只动变更区；`jsonEqual` 结构比较 |
| CLI 端到端 | `install-provider --json --dry-run` 不落盘；真写入 → 8 个内置模型；幂等；`uninstall-provider` 回到原字节；人文输出含 `dry run: nothing was written` 且**不含密钥** |
| CLI 失败路径 | 坏文件 → 退出码 1 + `models-json-unreadable` + 文件不变（顺带修掉了 `renderHuman` 在失败文档上崩溃的 bug） |
| 原子写降级 | 注入抛 `EPERM` 的 rename：仍写入成功、`write.mode === 'in-place'`、有 warning、**不留 tmp 文件** |

---

## 6. 真机实测

> 全部为本机真实运行；命令带 `timeout`；未启动 `serve`；未发推理。`models.json` 现在**保持已安装状态**（用户要求能在 subagent-win 里直接用）。

### 6.1 `install-provider --dry-run`（不落盘、不备份）

```
pi-workbuddy-connect install-provider — WorkBuddy (cn)
models.json: ~\.pi\agent\models.json
provider: workbuddy → http://127.0.0.1:8317/v1
api key: literal (6jxe…_m1U), from config — value never printed
catalog: saved (18 models) @ 2026-10-13T08:26:29.880Z
dry run: nothing was written, no backup was taken

--- a/~\.pi\agent\models.json
+++ b/~\.pi\agent\models.json
@@ -624,6 +624,182 @@
           }
         }
       ]
+    },
+    "workbuddy": {
+      "baseUrl": "http://127.0.0.1:8317/v1",
+      "api": "openai-completions",
+      "apiKey": "<gateway bearer secret>",
      ...
```

（diff 只追加我们那一段：**176 行** / 5918 字节；`config-backups/` 无新文件 —— 已实测。）

### 6.2 真机写入不受影响、可回滚（sha256 证据）

```
sha256 原文件           0d8e085ecb1c7d83ebe34c73b8adfbad6f8444c4fcd1d91c5e7816397c36891d  (17414 B, 21 provider)
install-provider 之后   007ca50127a2ad4c05db9be7743218fea190e53a185ca607aa061acccff8b913  (23332 B, 22 provider)
uninstall-provider 之后 0d8e085ecb1c7d83ebe34c73b8adfbad6f8444c4fcd1d91c5e7816397c36891d  ← 回到原值
reinstall 之后          007ca50127a2ad4c05db9be7743218fea190e53a185ca607aa061acccff8b913  ← 与上次安装逐字节相同
再次 install-provider  → "already installed and up to date: the file was not written"，sha 不变、备份不增（幂等）
```

字节级证明（把安装后的文件与安装前的备份对比）：

```
insertion point 17404
prefix byte-identical: true     ← 我们那段之前的全部字节相同
suffix byte-identical: true     ← providers 收尾与文件尾相同
inserted bytes: 5918 === added text length 5918
inserted text starts with: ",\r\n    \"workbuddy\": {\r\n      \""
```

即：**安装 = 原文件 + 在 `providers` 末尾插入 5918 字节**，没有重排、没有重格式化（F7 里那 291 行 CRLF/内联数组一个字节都没动）。

备份（真机）：

```
~/.pi/agent/config-backups/
  models.json.20261013T084843382Z.bak   ← 首次安装前（= 原文件）
  models.json.20261013T085208066Z.bak   ← uninstall 前（= 已安装状态）
  models.json.20261013T085208219Z.bak   ← reinstall 前（= 卸载后状态）
```

### 6.3 pi 侧解析（只读）

```
$ pi --offline --list-models workbuddy
provider   model                context  max-out  thinking  images
workbuddy  deepseek-v4-pro      1M       128K     yes       yes
workbuddy  deepseek-v4.1-flash  1M       128K     yes       yes
workbuddy  glm-5.1              200K     48K      yes       yes
workbuddy  glm-5.2              1M       64K      yes       yes
workbuddy  glm-5.3              1M       64K      yes       yes
workbuddy  glm-5.3-flash        1M       131.1K   yes       yes
workbuddy  glm-5v-turbo         200K     64K      yes       yes
workbuddy  hy3                  192K     64K      yes       yes
workbuddy  hy3-x                192K     64K      yes       yes
workbuddy  hy4-preview          960K     64K      yes       yes
workbuddy  kimi-k2.6            256K     32K      yes       yes
workbuddy  kimi-k2.7            256K     32K      yes       yes
workbuddy  kimi-k2.8-preview    1M       64K      yes       yes
workbuddy  kimi-k3-1            1M       32K      yes       yes
workbuddy  minimax-m2.7         200K     48K      yes       yes
workbuddy  minimax-m3           512K     64K      yes       yes
workbuddy  space-bunny          1M       128K     yes       yes
workbuddy  step-5-preview       1M       64K      yes       yes
（18 行；`--list-models` 全量 41 → 59 行，说明其它 provider 一个没丢）

$ pi --offline --list-models "workbuddy/glm-5.3"
workbuddy  glm-5.3        1M  64K  yes  yes
workbuddy  glm-5.3-flash  1M  131.1K  yes  yes      ← --list-models 是模糊搜索，故命中了同前缀的 flash
```

用 **pi 自己的解析器**做精确解析验证（动态导入 `dist/core/*.js`，不启动会话、不联网）：

```
models.json schema error: undefined          ← pi 的ModelConfig.load() 无校验错误
workbuddy/glm-5.3            -> workbuddy/glm-5.3
workbuddy/hy3                -> workbuddy/hy3
workbuddy/deepseek-v4.1-flash-> workbuddy/deepseek-v4.1-flash
```

### 6.4 subagent-win 里的用法

```js
// 推荐：完整 provider/id
subagent-win({ agent: "general", model: "workbuddy/glm-5.3", task: "..." });

// 或设为某 agent 默认（写 config.json 的 models 表）
// /sub-models implementer workbuddy/glm-5.3
// /sub-models implementer fallback Zhipu/glm-5.3
```

前提：
1. **`serve` 必须在线**（`node bin/pi-workbuddy-connect.js serve`，端口要与 `install-provider --port`/`--port` 一致）；
2. 登录态有效（网关复用本机 App 的登录态）；
3. 模型在目录里（`status --catalog` 刷新后重跑 `install-provider`）；
4. **不要用短名**（见 §7.2）。

---

## 7. 风险与设计取舍

### 7.1 pi 的严格 schema（最高风险，已用双重防线压住）
F3：一个未知键会让**整份 `models.json`** 失效、**所有** provider 消失（包括用户自己那 21 个）。防线：
1. 生成条目只包含 pi `ProviderConfigSchema` / `ModelDefinitionSchema` 的键，并有 `assertProviderEntryValid` 硬校验；
2. 测试里直接调用 **pi 自己的 `ModelConfig.load()`** 断言无错误 —— 这是"用 pi 的规则验证 pi 的文件"，不靠我们的复述；
3. 写入前 `assertSpliceSafe`：重解析后要求**其它 provider 深比较不变、provider 顺序不变**，任一不满足就**不写**；
4. 每次写入前先备份，出错可一键回退。

残余风险：pi 升级后若收紧 schema（例如新增必需字段），我们需要跟进重发。`uninstall-provider` 总能退回原状。

### 7.2 短名歧义（subagent-win 侧，需用户注意）
`workbuddy/glm-5.3` 与 `Zhipu/glm-5.3` 同时存在时，subagent-win 的 `normalizeModelRef`（只读分析，F8）会对短名 `glm-5.3` 得到两个 100 分候选 → 抛 `Ambiguous model alias`。**这是设计使然（避免猜错 provider），不是回归**；本轮**未**修改 subagent-win（不在可写范围）。缓解：文档与 README 明确要求写完整 `workbuddy/<id>`，或把 agent 默认值直接设成完整引用。
（未实测该函数：它在 `extensions/index.ts` 内部未导出，无法脱离 pi 会话单独调用；结论来自源码路径分析。）

### 7.3 网关密钥被复制到 `models.json`
默认把网关 bearer 写成**字面量**（该文件与 `gateway.json` 同为用户私有）。取舍：
- 好处：开箱即用，无需额外环境变量；与用户现有 `models.json` 的写法一致。
- 代价：密钥多一处落盘。`uninstall-provider` 会连带删掉；`--api-key-env NAME` 或 `WORKBUDDY_GATEWAY_TOKEN` 可改为**只写 `$NAME` 插值**，完全不落盘。
- 命令输出路径：密钥进入 `secrets[]` 走既有 redaction 自检；dry-run diff 用 `<gateway bearer secret>` 占位并额外做一次明文替换；人文/JSON 输出只显示 `6jxe…_m1U` 掩码。

### 7.4 目录来源可能过时/占位
命令**离线**（按纪律要求）。若无 `workbuddy-catalog.json` 缓存则写内置占位表（8 条），并在 `warnings` 里明确要求先跑 `status --catalog`。若缓存是降级的 `saved`（`degradedReason` 非空）也会告警。

### 7.5 本机 `renameSync` EPERM → 原地写降级
真机首次写入失败：`EPERM: operation not permitted, rename '…models.json.tmp-…' -> '…models.json'`（有进程占用该文件；`rename` 覆盖需要 DELETE 权限，普通写不需要）。已实现：原子路径失败且错误码属于 `EPERM/EBUSY/EACCES/ENOTSUP` → 清掉 tmp 后**原地写**，并在文档 `write.mode='in-place'` 与 warning 里说明（备份已在手，可回退）。注入式单测覆盖该分支。
**副作用**：原地写不是原子的，进程在写入中途被杀理论上可能截断文件 —— 因此备份是必需的，且失败信息里给出备份路径。

### 7.6 其它
- `cost` 全填 0：本项目不做本地记账（`docs/mechanism.md`），不发明价格；pi 侧成本显示为 0，真实计费在上游。
- `compat` 五个键是**依据 `docs/protocol.md` 的已验证上游差异**写的（`supportsStore:false`、`supportsDeveloperRole:false`、`maxReasoning` 支持、`supportsUsageInStreaming:false`、`maxTokensField:"max_tokens"`）；其中"上游是否接受 `stream_options`"**未做真机验证**，故选择不发。
- pi 的 `--list-models` 是**模糊搜索**，验证精确解析需要 §6.3 的动态导入方式（已在测试中固化）。
- 只支持**纯 JSON**：pi 能读 JSONC（注释），本工具会**拒绝编辑**带注释的文件（fail closed，给出提示），避免用错工具毁掉用户手写注释。

---

## 8. 未做项 / 未验证项

1. **未发 npm**（按用户口径）。
2. **未启动 `serve`**，因此**没有**验证"pi → 网关 → 上游"的端到端真实推理（纪律要求零上游推理）。`install-provider` 与 pi 解析为实测；真机推理沿用 S1 的证据。
3. **企业分支 / 国际版（`--variant ai`）未实测**：代码路径一致（`variant.catalogFilename`/`ownDir`），但本机只登录了国内版。
4. **subagent-win 的 `normalizeModelRef` 短名歧义**为源码分析，未实测（见 §7.2）；未修改 subagent-win。
5. 未实现"安装后自动 `pi --list-models` 自检"（需调用外部 pi，超出本工具职责；已写入 README 手动步骤）。
6. 未实现 `install-provider --refresh`（在线刷新目录）：保持命令零网络；刷新走 `status --catalog`。
7. `docs/dev/S1-report.md` 里"`/v1/models` ids 形如 `workbuddy/<id>`"是**当时的事实记录，未改写**；现行行为以 `docs/protocol.md` 与本报告为准。

---

## 9. 纪律核对

| 项 | 状态 |
|---|---|
| 不 commit / 不 push | ✅ 全部改动未跟踪/未提交（`git status` 待 Master 复审后统一处理） |
| 仓外只读 | ✅ `subagent-win` 只读、`G:/code/**`、`~/.workbuddy`、桌面 auth 文件均未触碰 |
| 改 `models.json` 前备份 | ✅ 3 次写入（首次安装 / 卸载 / 重装）各有备份，文件名带毫秒时间戳 |
| 只动我们那段 | ✅ §6.2 字节级证明 + 测试用例双证 |
| 写后自检 pi 仍能列模型 | ✅ `pi --offline --list-models` 59 行；pi 自身 schema 校验无错 |
| 不发推理 / 不起 serve / 不留后台进程 | ✅ 只读命令 + 动态导入；无 serve 进程 |
| 所有命令 timeout | ✅ |
| 文档同步 | ✅ README「接入 pi / subagent-win」、`docs/protocol.md`、本报告 |

---

## S2.1 增补（2026-10-13）：模型暴露可配置 + 端口自动选择 + L4 复审闭合

> 完整证据见 [`S2.1-report.md`](./S2.1-report.md)。本节只记结论与数字。

| 项 | 结果 |
|---|---|
| 模型暴露可配置 | 单一配置源 `gateway.json.models = { mode: "all"|"allowlist", expose: [...] }`，三处共用：`GET /v1/models` 只列暴露集合；`POST /v1/chat/completions` 对未暴露模型返回 `404` + `error.code="model_not_found"` + `workbuddy_reason_code="model-not-exposed"`；`install-provider` 只写暴露集合。CLI 新增 `models list/set/add/remove/all`（`--json`）；`serve --models a,b` / `install-provider --models a,b` 仅本次覆盖 |
| 端口 | 默认由 `8317` 改为 `8799`；解析顺序 `--port` > `WORKBUDDY_GATEWAY_PORT` > `gateway.json.port` > `8799`；**占用时自动挑空闲端口**（主动探测，因 Windows 上两进程可绑同一端口），实际端口/baseUrl 写入 `endpoint.json`；`install-provider` 默认读 `endpoint.json` 的实际端口，不再盲写 8317 |
| MF-1 | 内联非空 `providers` 现在可安装（新增 `indentWhitespaceAt` 修正一行式文件的缩进），不再报误导性 `would not parse`；新增用例 |
| SF-1 | 已查证 pi `docs/models.md` 支持 `$NAME`/`${NAME}` 插值；`--api-key-env WORKBUDDY_GATEWAY_TOKEN` 设为 README 推荐路径并**在本机采用**；字面量时输出首行 `PLAINTEXT SECRET` 警告；永不打印密钥 |
| SF-2 | 写入前按 sha256 复核「读取快照 vs 落盘前」，不一致 fail-closed 拒绝并提示重试；新增模拟中途变更用例 |
| SF-3 | 本报告 `plans/1013_S2-models-provider.md` → `docs/dev/1013_S2-models-provider.md`（已改 2 处） |
| SF-4 | 按复审 ④ 清单加指针（README L243 结论句 + `docs/dev/S1-report.md` 8 处 + `docs/dev/S1-review.md` 2 处），不重写原始实测值 |
| 测试 | `node --test` → **168/168 全绿**（S2 的 150 + 新增 18） |
| 本机实测 | 暴露集合 = `["deepseek-v4.1-flash"]`；`pi --offline --list-models workbuddy` 仅 1 条数据行；非 workbuddy 行数 41 不变；其它 21 个 provider 与原始备份**逐字节相同**（前缀 17404 B / 后缀 10 B）；uninstall 回到原 sha `0d8e08…`；占用端口场景自动改挑空闲端口并写入 `endpoint.json` |
| 纪律 | 未 commit/push；零上游推理（serve 用不存在的 `--auth-file` 走 saved 目录，全部本地）；无残留进程/端口 |

