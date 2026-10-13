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
`127.0.0.1`. Therefore the gateway enforces **four gates before routing**:

1. **Host header must be loopback** (`127.0.0.1` / `localhost` / `[::1]`) — defeats DNS rebinding.
2. **Browser Origin must be loopback** (requests without an Origin are non-browser and are allowed).
3. **Bearer token must equal a per-process random secret**, compared in constant time. The secret is
   generated fresh per process, kept in memory, never written to disk and never sent anywhere except
   toward the local gateway.
4. **`Content-Type: application/json`** on chat POSTs — a low-cost CSRF backstop.

Additional hardening: a request body size limit, and an idle timeout on upstream streams with
`[DONE]` termination so clients do not hang on a truncated stream.

## 4. Outbound traffic

- Credentials are sent **only** to the three upstream hosts (see `protocol.md`).
- Optional update checks contact public package/release metadata hosts with **no credentials**.
- There is **no telemetry** and no crash reporting.

## 5. Repository hygiene

- `.gitignore` covers credentials, tokens, cookies and local state snapshots.
- CI scans the tree for token-like patterns and fails on a hit.
- Documentation and issues must reference **field names**, never values.

## 6. Owner-copy permissions (S3)

A refreshed token, if one is ever written, goes to a project-owned directory with owner-only
permissions:

| Platform | Directory | Mode |
|---|---|---|
| Windows | `%APPDATA%\pi-workbuddy-connect\` | directory only; NTFS ACLs are not `chmod` |
| macOS | `~/Library/Application Support/pi-workbuddy-connect/` | `0700` dir, `0600` file |
| Linux | `$XDG_STATE_HOME` (or `~/.local/state`) `/pi-workbuddy-connect/` | `0700` dir, `0600` file |

Notes and residual risks:

- The at-rest key used to unwrap the desktop credential is held **in memory only**. It is never
  written to disk, never cached, and never sent anywhere.
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
