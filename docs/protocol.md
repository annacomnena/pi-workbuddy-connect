# Protocol reference (observed facts)

> Field **names** only — no values, no account data. These are observations of a private,
> non-public interface; they can change at any time without notice. See the disclaimer in `README.md`.

## 1. Base selection

| Region | Chat | Billing | Promotions |
|---|---|---|---|
| CN (`domain` not `*.workbuddy.ai`) | `https://copilot.tencent.com` | `https://www.codebuddy.cn` | `https://copilot.tencent.com` |
| Global (`domain` is `*.workbuddy.ai`) | `https://www.workbuddy.ai` | `https://www.workbuddy.ai` | — |

Region is derived from the **login domain stored in the credential**, not from configuration.

## 2. Endpoints

### 2.1 Chat (streaming)

```
POST {chatBase}/v2/chat/completions
Authorization: Bearer <accessToken>
Content-Type: application/json
<client identity headers, see §3>
```

Body: OpenAI-shaped chat completions request, after shaping (§4). Response: SSE stream.

### 2.2 Token refresh

```
POST {chatBase}/v2/plugin/auth/token/refresh
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: <source marker>
<optionally: enterprise header>
```

No `Authorization` header and no body. Response envelope carries a new access token, an optional new
refresh token, an expiry duration and the domain. This refresh header appears on **this endpoint only**.

### 2.3 Model catalog

```
GET {chatBase}/v3/config
Authorization: Bearer <accessToken>
```

The returned roster depends on client identity (User-Agent). Parsed per model:
`id`, display name, `credits` (rate multiplier string, e.g. `x0.79`), `tags` (promotion badges,
prefixed `badge:`), reasoning declaration, context window(s).

### 2.4 Billing — personal

```
POST {billingBase}/v2/billing/meter/get-user-resource
Authorization: Bearer <accessToken>
X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain   (as available)
Content-Type: application/json
```

Request body includes paging, a product code, a status filter and a package-end-time range.
Response packs carry: pack name, cycle capacity size / remain / used, remaining / size, cycle end time.

### 2.5 Billing — CN enterprise

```
POST https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage
Authorization: Bearer <accessToken>
X-User-Id / X-Enterprise-Id / X-Tenant-Id / X-Domain
Content-Type: application/json
```

Empty body object; identity travels entirely in headers. Response carries a limit, a used amount and a
cycle reset time; a sentinel limit means "unlimited". Used only for CN credentials whose enterprise id
is non-empty.

## 3. Client identity headers (chat)

| Header | Meaning |
|---|---|
| `X-User-Id` / `X-No-User-Id: 1` | user id, or explicit "none" |
| `X-Enterprise-Id` / `X-No-Enterprise-Id: 1` | enterprise id, or explicit "none" |
| `X-Domain` / `X-No-Department-Info: 1` | domain, or explicit "none" |
| `X-IDE-Type`, `X-IDE-Name`, `X-IDE-Version` | client identity/version |
| `X-Product` | product marker |
| `Origin` / `Referer` | region-appropriate origin |
| `User-Agent` | client identity, **version taken from the locally installed app** |

Billing requests carry the authorization + identity headers but no client User-Agent.

## 4. Body shaping rules

- Force `stream: true`.
- Rewrite `role: "developer"` → `role: "system"`.
- Flatten `tool_choice` to a string form.
- Ensure a leading `system` message for the global deployment.
- Strip a "thinking off" effort value.

## 5. Errors

Envelope-based responses carry a business code plus message/data. Non-zero business codes are
classified like HTTP errors. Localised display messages are preferred when present; error bodies are
truncated (4 KiB) before surfacing. Classes and status mapping: see `mechanism.md` §5.

## 6. The local gateway surface (S1)

The gateway is a *local* surface, not an upstream one. It speaks OpenAI so any client can point at it:

| Method + path | Bearer | Notes |
|---|---|---|
| `GET /healthz` | no | status/version/masked account/decryptability/cooldowns; never contacts upstream; readable by any local process (no bearer) |
| `GET /v1/models` | yes | OpenAI list; ids are `workbuddy/<upstream model id>`; carries `group`, `context_window`, `max_output_tokens`, `capabilities` and `workbuddy_source` (live/saved/builtin) |
| `POST /v1/chat/completions` | yes | `stream:true` -> SSE passthrough; `stream:false` -> the SSE is folded into one `chat.completion` |
| `GET /v1/workbuddy/credits` | yes | **non-standard convenience endpoint**: masked, read-only balance |

Inbound gates run before any route is served: loopback `Host`, loopback `Origin` when present, a
per-process random bearer compared in constant time, and `application/json` on non-GET requests. Route
matching happens between the origin and bearer gates, so an unknown path is `404` even without a bearer;
no data is exposed. The server binds `127.0.0.1` only.

Outbound-wise the gateway is a translator: it forces `stream: true`, maps `workbuddy/<id>` to the
upstream id, and passes `usage` through. The streaming path forwards the upstream SSE verbatim
(including every `usage` sub-field such as `credit`); the non-streaming fold normalises `usage` to
`prompt_tokens` / `completion_tokens` / `total_tokens` and drops fields it does not model such as
`credit` and `completion_thinking_tokens`. If the upstream stream breaks mid-answer, a
`workbuddy_truncated` frame is written before `data: [DONE]`; if it breaks before any byte has been
forwarded, the request is answered `502`. It keeps **no local ledger**: usage and charging are computed
server-side by the upstream, and the only admission control is a per-model cooldown the upstream itself
signals with `429`/`402`.

## 7. Self-imposed limits on outgoing traffic

The only outbound hosts are the three upstream hosts above (with credentials) plus, optionally,
public package/release metadata hosts for update checks (**no credentials, accept-header only**).
Local traffic stays on `127.0.0.1`.
