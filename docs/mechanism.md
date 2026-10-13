# Mechanism — how WorkBuddy Connect works

> This document describes the **observed protocol facts** of the WorkBuddy desktop app's private
> interfaces, as used by this project. It contains **no credential values, no account identifiers and
> no personal data** — only field names, endpoint paths and structural descriptions.
> 本文档只描述**观察到的协议事实**（端点、字段名、结构），**不含任何凭据值、账号标识或个人数据**。

## 0. Summary

This project does **not** log in anywhere. It reuses the login state that **your own** WorkBuddy
desktop app already wrote to disk (read-only), then exposes that account's models through a
**local OpenAI-compatible endpoint** on `127.0.0.1`. Spending happens on **your own** account and
**your own** credits, server-side, exactly as if you used the desktop app.

```
your OpenAI-compatible client
  → http://127.0.0.1:<port>/v1/chat/completions      (Bearer = per-process random secret)
  → local gateway: Host/Origin/Auth/Content-Type gates
  → credential store: read latest credential, refresh once if near expiry
  → protocol shaping: force streaming, developer→system, tool_choice as string
  → POST {chatBase}/v2/chat/completions              (Bearer + client identity headers)
  → upstream bills the request server-side (this project never touches credits)
  → SSE streamed back verbatim
```

## 1. Credential source (read-only)

Login state comes exclusively from the **desktop app's own auth file**:

| Variant | File basename (inside the app's auth directory) | Region |
|---|---|---|
| WorkBuddy (CN) | `workbuddy-desktop.info` | `cn` |
| WorkBuddy AI (Global) | `workbuddy-desktop-ai.info` | `global` |

Discovery order: explicit config path → environment variable → per-platform candidate list
(macOS Application Support; Windows Local then Roaming AppData; Linux XDG config/data; WSL mounted
Windows user dirs first). The two variants share the auth **directory** and differ only by basename.

The stored document is **partially** encrypted: structural fields (uid/uin/expiry/domain) are
plaintext, while `accessToken` / `refreshToken` are wrapped in a per-field envelope
(`{$wbEncrypted: 1, envelope: <base64 JSON>}`). Unwrapping requires the app's own at-rest key, which
is obtainable only through the app's Electron binary — see `security.md`.

Validity / refresh: an access token is refreshed when it is within a small margin of expiry, against
the upstream refresh endpoint, using a dedicated refresh-token header. The refreshed credential is
written **only into this project's own state directory** (mode `0600` on POSIX; on Windows there is
no POSIX mode and the copy relies on the user profile's inherited ACLs — see `security.md` §6). The
desktop app's auth file is **never written to**.

## 2. Upstream endpoints (all 5 kinds)

| Purpose | Method | Path | Base |
|---|---|---|---|
| Chat (streaming) | POST | `/v2/chat/completions` | CN chat base / global base |
| Token refresh | POST | `/v2/plugin/auth/token/refresh` | CN chat base / global base |
| Model catalog | GET | `/v3/config` | CN chat base / global base |
| CN promotion badges | GET | `/console/enterprises/personal/models` | CN chat base |
| Billing (personal) | POST | `/v2/billing/meter/get-user-resource` | CN billing base / global base |
| Billing (CN enterprise) | POST | `/v2/billing/meter/get-enterprise-user-usage` | CN billing base |

The base is chosen from the **login domain** recorded in the credential: a `*.workbuddy.ai` domain
means the global deployment, otherwise the CN deployment. CN splits chat and billing across two hosts;
the global deployment uses one host for all three purposes.

Billing responses carry the resource-pack / cycle-capacity numbers (pack name, size, remaining, used,
cycle end). Enterprise reads return a limit plus used amount, with a sentinel meaning "unlimited".

## 3. Credits and rate multipliers

- **Billing is server-side.** This project performs **no local pre-deduction, no local accounting and
  no balance gate**. A chat request is never preceded by a balance check; if credits are exhausted,
  the upstream answers with a payment-required status or a credit marker in the error body.
- **Balance is a side channel.** Billing endpoints are queried only when a status document is built
  (and on explicit user refresh). There is no background balance polling.
- **Rate multipliers (e.g. `x0.79`) and promotion badges are display-only.** They are appended to a
  model's *display name*; the wire request only ever uses the model **id**. Nothing in this project
  multiplies a multiplier by a token count, and the client-side cost field is pinned to zero.

## 4. Wire-protocol quirks (must be reproduced)

Observed on the CN and global chat endpoints:

- **Streaming is mandatory** — non-streaming requests are rejected.
- **`tool_choice` must be a string**, not the nested object some clients emit.
- **`role: "developer"` must be rewritten to `system`**; leaving it fails the request.
- The global deployment requires a leading `system` message.
- A "thinking off" effort value is stripped before sending.
- Client identity travels in headers (user / enterprise / domain, `X-IDE-*`, product); when a value is
  absent, explicit "no-…" marker headers are sent instead.
- The **User-Agent matters**: the catalog gateway dispatches different rosters based on client
  identity. This project uses the identity consistent with the locally installed app and its version,
  and never fabricates a version newer than the local one.

## 5. Error classification

| Upstream condition | Class | Returned to client |
|---|---|---|
| 402, or an error body containing a credit marker | `hard_credit` | 402 |
| 401, or a dead-session marker | `session_dead` | 401 |
| 429 | `soft_rate` | 429 |
| 404 | `not_found` | 502 |
| ≥ 500, or a transport error | `server` | 502 |
| other ≥ 400 | `client` | 400 |

Errors are surfaced in OpenAI error shape (`{error: {message, type, code}}`). Rate-limit responses are
never retried in a storm, and are never "worked around" by switching identity.

## 6. Reasoning-effort detection (opt-in, costs credits)

Some models declare effort tiers; others do not. Probing undeclared tiers means sending **real** chat
requests (which **consume credits**), so it is strictly user-initiated, single-model, and never
automatic. A successful probe only means the upstream *accepted* the value; it does not prove the tier
changes reasoning behaviour, latency or cost.

## 7. What this project deliberately does not do

See `compliance.md`. In short: no multi-account pooling, no automated check-in / credit farming, no
billing or rate-limit bypass, no telemetry, no credential egress to non-upstream hosts, no writes to
the desktop app's files, no non-loopback listener.
