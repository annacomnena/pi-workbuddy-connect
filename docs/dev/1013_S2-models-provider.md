# S2 实现计划 — 把本地反代接入 pi 模型体系（`models.json` 自动生成 provider）

- 日期：2026-10-13
- 仓：`C:/Users/Annacomnena/pi-packages/pi-workbuddy-connect`（HEAD `6d8b992`，工作区干净）
- 目标口径：S2 要做；`~/.pi/agent/models.json` 里自动生成/更新**只属于我们那一段** provider，使 `subagent-win({ model: "workbuddy/<id>" })` 可用；暂不发 npm；不碰企业/国际版。

## 1. 已核实的上游事实（侦察结论，实现依据）

| # | 事实 | 出处 |
|---|---|---|
| F1 | pi 用 `--model` / 注册表把 `provider/id` 在**第一个 `/`** 处切开：`workbuddy/glm-5.3` → provider `workbuddy`、model id `glm-5.3`。规范匹配是 `${provider}/${id}` 全等 | `pi-coding-agent/dist/core/model-resolver.js` `findExactModelReferenceMatch` |
| F2 | provider 定义只能来自 `models.json` 的 `providers.<key>`（或扩展）。`api: "openai-completions"` + `baseUrl` + `apiKey` 即可；`baseUrl`/`api` 必需 | `dist/core/provider-composer.js` `modelFromJson` |
| F3 | `models.json` **严格 schema**（TypeBox，未列出的键 = 非法 → 整份文件被拒，pi 会报 `Invalid models.json schema` 且**所有** provider 都不加载）。允许键见 `ProviderConfigSchema` / `ModelDefinitionSchema` | `dist/core/model-config.js` |
| F4 | `apiKey` 支持字面量 / `$NAME`、`${NAME}` 环境插值 / `!command` | `docs/models.md` |
| F5 | 路径 = `${PI_CODING_AGENT_DIR:-~/.pi}/agent/models.json` | `dist/config.js` `getAgentDir()`/`getModelsPath()` |
| F6 | `compat` 是「provider 级 + model 级逐键浅合并」，键集受限（见 F3） | `provider-composer.js` `mergeCompat` |
| F7 | 本机 `models.json` 现状：21 个 provider、**CRLF**、2 空格缩进、短数组有的内联（`["text"]`）有的换行 —— 即**不是** `JSON.stringify(...,2)` 的输出；naive 重写会把 291 行全部改行尾、把内联数组展开 | 实测（round-trip identical = false） |
| F8 | subagent-win 侧：`model` 参数经 `normalizeModelRef()` —— 已含 `/` 的原样透传；短名从 `~/.pi/agent/models.json` + `~/.pi/models.json` 的 `providers[].models[].id` 展开；**唯一匹配才展开，多匹配抛 Ambiguous**。交互式 `/sub-models` 列表来自 `ctx.modelRegistry.getAvailable()` | `subagent-win/extensions/index.ts` L421-520/L3743 |
| F9 | pi 只读校验命令：`pi --offline --list-models [search]`（不推理、不联网） | `pi --help` |
| F10 | 网关 `/v1/models` 现在把 id 前缀化（`modelList()` → `withModelPrefix`），请求侧 `stripModelPrefix` 双向接受带/不带前缀 | `src/gateway/openai.js`、`src/protocol/body.js` |

## 2. 命名对齐方案（结论）

选定 **(a)：网关把 `id` 暴露为无前缀的上游 id，旧 `workbuddy/<id>` 作为别名保留**。

理由（详见交付报告，这里只列结论）：
- 用户要求的 ref 形式 `workbuddy/<id>` 要求 pi 的 **provider key 必须是 `workbuddy`** → 方案 (b)（provider 用别的名字）会产出 `别的名/...`，不满足用户口径，排除。
- provider key = `workbuddy` 后，models.json 的 `models[].id` **必须**是裸 id，否则 pi ref 变成 `workbuddy/workbuddy/<id>`（双前缀陷阱）。
- 因此把 `/v1/models` 的规范 `id` 也改成裸 id：**广告 id ≡ models.json id ≡ 请求体 id ≡ 上游 id**，四层同一个字符串。
- 旧前缀不破坏：请求侧本来就 `stripModelPrefix`（带前缀的客户端继续可用），并在每条模型上新增非标准字段 `workbuddy_prefixed_id` 让旧拼写仍可被发现。
- install-provider 另加防御：若目录里仍带 `workbuddy/` 前缀（旧网关/缓存），生成时**规范化去掉**。

## 3. 交付物

### 3.1 新增源码

| 文件 | 职责 |
|---|---|
| `src/provider/models-json.js` | 纯函数：`findProvidersSpan`/`listMembers`（JSON 感知扫描器）、`insertMember`/`replaceMember`（**字节级外科手术**，其它 provider 原文不动）、`renderProviderMember`（按文件自身的换行/缩进风格渲染）、`lineDiff`（最小 hunk 的 dry-run diff）、`canonicalModelId`、`buildProviderEntry`、`assertProviderEntryValid` |
| `src/provider/install.js` | IO 层：`resolveModelsJsonPath`、`readModelsJson`、`backupModelsJson`、`installProvider`、`uninstallProvider`、写前后 `verifyUnchangedOthers`（fail closed） |

### 3.2 CLI（`src/cli.js`）

- `install-provider [--dry-run] [--json] [--port N] [--variant cn|ai] [--models-json <path>] [--api-key-env <NAME>] [--refresh]`
- `uninstall-provider [--dry-run] [--json] [--models-json <path>]`
- 默认**全离线**：目录走 saved 缓存（`%APPDATA%/pi-workbuddy-connect/workbuddy-catalog.json`）→ builtin 占位（报告 `catalog.source`）；`--refresh` 才走一次目录读取（非推理）。
- 密钥：`loadOrCreateToken`（不存在则生成，落 `gateway.json` 0600）。token 来自 env（`WORKBUDDY_GATEWAY_TOKEN`）时写 `${WORKBUDDY_GATEWAY_TOKEN}` 插值，否则写字面量（或 `--api-key-env` 指定插值名）。**任何输出都不打印 token**，token 进 `secrets[]` 走既有 redaction self-check。
- 备份：`~/.pi/agent/config-backups/models.json.<UTC 时间戳>.bak`；`--dry-run` 不备份、不落盘。

### 3.3 网关改动（命名对齐）

`src/gateway/openai.js` `modelList()`：`id` = 裸 id；新增 `workbuddy_prefixed_id`；列表级 `workbuddy_id_style: "bare"`。
同步改：`test/gateway.test.js` 断言、`docs/protocol.md`、`src/gateway/server.js` 头注释。`src/protocol/body.js` 的 `withModelPrefix` 保留（供 `workbuddy_prefixed_id` 与旧客户端用）。

### 3.4 测试（`node --test`）

新增 `test/provider-install.test.js`（临时目录夹具，全程离线、不写真实 `~/.pi`）：
1. `--dry-run` 不落盘、不备份、diff 含 `+`、**diff 里没有 token 明文**；
2. 首次写入 `changed:true`，二次运行 `changed:false` 且文件**字节完全一致**（幂等）；
3. 其它 provider **原文逐字节不变** + 深比较不变；键序不变；
4. 备份文件存在且内容 == 原文件字节；
5. `uninstall-provider` 只删我们那段；其它 provider 原文不变；二次 uninstall `changed:false`；
6. 命名对齐：provider key == `workbuddy`；model id 裸；带旧前缀的目录 id 被规范化；
7. 坏 JSON / 带注释 / 非对象 → fail closed、不写；其它 provider 未被破坏的写前自检（构造性反例）；
8. 路径解析：`--models-json` > `PI_CODING_AGENT_DIR` > 默认 `~/.pi/agent/models.json`；
9. CRLF 与 2 空格缩进保持；空文件 / 无 `providers` 键 / providers 为空对象也能插入；
10. apiKey：env 来源 → 插值写法；`--api-key-env` → 插值写法；
11. 生成的 provider 条目**键集**在 pi 允许键内（防 F3 整份文件被拒）。

同步修既有用例：`test/gateway.test.js`、`test/protocol-body.test.js`（新增 `*_prefixed_id` 断言）。

### 3.5 文档

- `README.md`：新增「接入 pi / subagent-win」一节（安装/卸载、示例、前提、故障排查）。
- `docs/dev/S2-report.md`：命名方案论证、命令用法、示例、测试真实输出、风险（F3 严格 schema、F8 短名歧义、token 复制问题、serve 必须在线）、未做项。
- `docs/protocol.md`：id 形态更新 + 别名说明。

### 3.6 实测（真实环境，不回滚）

1. `install-provider --dry-run`（不写）→ 贴真实输出；
2. 备份已生成 → `install-provider`；
3. `pi --offline --list-models workbuddy` / `--list-models workbuddy/glm-5.3` → 逐条被解析；
4. `node --test` 全绿；
5. 写后自检：`JSON.parse` 成功、旧 21 个 provider 深比较不变、键序不变。

## 4. 纪律

不 commit / 不 push；不动 `G:/code/**`、`~/.workbuddy`、桌面 auth 文件；不启动 serve、不发任何推理请求；改 `~/.pi/agent/models.json` 前先备份、只动我们那段；所有命令带 `timeout`；不留后台进程。
