# Security model

## 1. Credential handling

| Aspect | Approach |
|---|---|
| Source | The desktop app's own auth file, **read-only** |
| Refresh output | This project's own state directory, mode `0600` (dir `0700` where supported) |
| Desktop file writes | **Never** — the app remains the authority for its own login |
| Region binding | A credential whose login domain does not match the selected variant is rejected outright, never silently coerced |
| Failure mode | If the credential cannot be read or unwrapped, the tool reports an explicit reason — it never silently degrades to "not signed in" |

## 2. At-rest unwrapping (if the credential is encrypted)

Modern app builds encrypt the token fields with an envelope that can only be opened with an at-rest
key held by the app. Obtaining it requires running the app's own binary in Node mode and asking its
internal storage binding for the payload.

- This is a **local, read-only** operation: it requests a key and writes nothing.
- It executes the **app's own binary** already installed on the machine. If you prefer not to do that,
  point the tool at a plaintext credential file via configuration instead.
- Timeouts and output limits are applied; the binary path is resolved from an explicit setting, an
  environment variable, or platform-specific discovery (bundle id / uninstall registry entry) — never
  from an arbitrary path.
- Discovery subprocesses use absolute system tool paths with argument allow-lists.

## 3. Loopback gateway

`loopback bind is not a trust boundary` — any local process, and any DNS-rebinding web page, can reach
`127.0.0.1`. Therefore the gateway enforces **four gates before it dispatches to a route or calls the
upstream**:

1. **Host header must be loopback** (`127.0.0.1` / `localhost` / `[::1]`) — defeats DNS rebinding.
   A failure is **403**.
2. **Browser Origin must be loopback** (requests without an Origin are non-browser and are allowed).
   A failure is **403**.
3. **Bearer token must equal this process's secret**, compared with `timingSafeEqual` after a length
   check. A missing or wrong bearer is **401**. The secret is 32 random bytes generated on first start
   and stored in `gateway.json` in this project's own state directory (0600 requested; on Windows,
   inherited ACL only). `WORKBUDDY_GATEWAY_TOKEN` overrides it and, when set, nothing is persisted.
   **`/healthz` is deliberately exempt**: it is the readiness probe, it returns no credential
   material, and it never contacts the upstream.
4. **`Content-Type: application/json`** on non-GET requests — a low-cost CSRF backstop. A failure is
   **415**.

The listening address is never configurable: the server binds `127.0.0.1` only, and the actual port is
announced in `endpoint.json` (which never contains the secret).

Route matching happens between gates 2 and 3: an unknown path is answered **404 `not_found` before the
bearer is checked**, so an unauthenticated caller can tell an existing route from a missing one. No
route data is exposed and no upstream call is made, so this is not a security boundary — the wording
above is deliberately "before dispatch", not "before routing".

Additional hardening: a 64 MiB request body cap, per-model cooldowns read from upstream `429`/`402`
answers (`Retry-After` or a UTC+8 timestamp in the body, capped at 2 h) so a throttled model is refused
immediately instead of being retried, and truncation signalling when an upstream stream breaks: if no
byte has been forwarded yet the request fails as **502** with an OpenAI error body, and if the stream
breaks mid-answer the gateway appends a `workbuddy_truncated` SSE frame before `data: [DONE]` so a
partial answer is distinguishable from a complete one. A clean upstream `end` without `[DONE]` is marked
the same way.

The gateway performs **no local accounting**: no pre-deduction, no ledger, no balance gate. Usage and
charging are computed **server-side by the upstream**; this tool does not claim that any particular
request was charged, only that it performs no local billing. `/healthz` requires no bearer and is
readable by **any local process** (it carries masked metadata only, never a credential).

## 4. Outbound traffic

- Credentials are sent **only** to the three upstream hosts (see `protocol.md`).
- Optional update checks contact public package/release metadata hosts with **no credentials**.
- There is **no telemetry** and no crash reporting.

## 5. Repository hygiene

- `.gitignore` covers credentials, tokens, cookies and local state snapshots.
- CI scans the tree for token-like patterns and fails on a hit.
- Documentation and issues must reference **field names**, never values.

## 6. Owner-copy storage protection (S1, SF-6)

The project's own credential copy (written only after a successful token refresh — never the desktop
file) is **no longer plaintext by default**. Its format records which protection was used:

| Order | Protection (`protection` / `keySource`) | When it applies |
|---|---|---|
| 1 | `aes-256-gcm` / `at-rest-key` | The app's own at-rest key is available (the normal case: the desktop credential is an encrypted envelope, and the same key unwraps it). A fresh random nonce per write; AAD binds the blob to this project and format version. |
| 2 | `aes-256-gcm` / `os-dpapi` \| `os-keychain` \| `os-libsecret` | No at-rest key available (plaintext desktop install): a dedicated 32-byte key is generated and handed to **Windows DPAPI (CurrentUser)**, **macOS Keychain**, or **Linux libsecret**. DPAPI stores the wrapped blob in `own-copy.key` beside the copy; the other two store it in the OS store itself. |
| 3 | `plaintext` / `none` | **Only** when neither is available. This is an explicit degradation: the gateway logs `SF-6 DEGRADED: …` at startup and it is listed in the `serve` document. Permissions stay best-effort 0600 on POSIX and inherited-ACL on Windows. |

Rules that make this fail closed rather than fail open:

- A sealed copy whose key cannot be produced is reported as `credential-undecryptable` — it is **never**
  read as "no copy" and never silently downgraded to the desktop file when no desktop file exists.
- A `keyId` mismatch (rotated at-rest key) is a failure, not a retry against another key.
- The OS helpers run local system tools (`powershell.exe` with an encoded command, `/usr/bin/security`,
  `/usr/bin/secret-tool`) with a fixed argument list, a 10 s timeout and a 64 KiB output cap. No key or
  credential is ever sent anywhere.

## 6b. Owner-copy permissions

A refreshed token, if one is ever written, goes to a project-owned directory with owner-only
permissions:

| Platform | Directory | Mode |
|---|---|---|
| Windows | `%APPDATA%\pi-workbuddy-connect\` | directory only; NTFS ACLs are not `chmod` |
| macOS | `~/Library/Application Support/pi-workbuddy-connect/` | `0700` dir, `0600` file |
| Linux | `$XDG_STATE_HOME` (or `~/.local/state`) `/pi-workbuddy-connect/` | `0700` dir, `0600` file |

Notes and residual risks:

- The at-rest key used to unwrap the desktop credential is held **in memory only** for the duration of
  a resolve. It is never sent anywhere. (The only thing ever written is the *copy* sealed with it, or a
  DPAPI/Keychain/libsecret-wrapped key beside the copy — never the key itself in the clear.)
- A copy in a home directory may still be captured by backups, file-sync clients, or a shared
  machine. Excluding the path above from sync/backup is the owner's responsibility.
- On Windows there is no POSIX mode; the copy is only as private as the user profile's ACLs. This is
  the reason S3 stores nothing but the credential and does not persist the at-rest key.

## 7. Log-leak warning

The desktop app's own log directory may contain **plaintext** bearer values in some builds. This
project **never reads or copies those logs**, and neither should you. If you paste diagnostics into a
public issue, scan them first for token shapes; the CLI's own output is already masked and passes a
pre-print token self-check.

## 8. Fail-closed diagnostics (S3)

`doctor` distinguishes credential states instead of collapsing them into "not signed in": missing,
unreadable, undecryptable, region-mismatched, expired, and unreachable are separate reason codes. The
`status` / `doctor` documents are scanned for token shapes and for the exact secrets the process holds
before printing, and are withheld if a hit is found.

The gateway fails closed in the same spirit, with the failure named in the response:

| Situation | Response |
|---|---|
| no local credential | `401 not_signed_in` |
| token expired and refresh failed | `401 session_dead` |
| upstream says the session is gone (401 / `Offline user session not found` / `12153`) | `401 session_dead`, and the event is surfaced on `/healthz` (`credential.lastSessionDead`) |
| own copy sealed and its key is gone | `502 credential-undecryptable` (never "not signed in") |
| upstream 402 / credit marker | `402 hard_credit`, no retry |
| upstream 429 | `429 soft_rate` + `Retry-After`, then a local per-model cooldown |
| upstream unreachable / 5xx / non-JSON | `502` |
| upstream 4xx | `400` |

The gateway logs the model, status, latency and stream mode per answer. It never logs a prompt, a
completion or a credential.
