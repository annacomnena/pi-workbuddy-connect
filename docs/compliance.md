# Compliance & security boundaries

## 1. Non-affiliation

This project is **unofficial** and is **not affiliated with, endorsed by, or connected to** Tencent,
WorkBuddy, WorkBuddy AI, or DeepSeek. Product names are used only to describe compatibility.
Code is licensed under MIT; **MIT covers the code only** and grants no rights to any vendor's service,
API, or trademarks.

## 2. What this project relies on

It reuses **the private interfaces of the locally installed desktop app** — not a public, documented
API. Such interfaces can change at any time. Using them may conflict with the vendor's terms of
service. **You are responsible for your own use**, and for keeping it within the vendor's terms.

## 3. Invariants (enforced by design and by review)

1. **Your account only.** One credential, read from **your own** machine, for **your own** account.
   No proxying other people's requests.
2. **Your credits only.** Spending is server-side and identical to normal desktop-app usage. No
   billing, quota or rate-limit mechanism is bypassed.
3. **Desktop files are read-only.** The app's auth file is never written to or modified. Refreshed
   tokens go to this project's own state directory only.
4. **Loopback only.** The local endpoint binds `127.0.0.1` and requires a per-process secret plus
   Host/Origin validation. It is never exposed to a LAN, the internet, or as a shared proxy.
5. **No credential egress.** Credentials are only ever sent to the vendor's own upstream hosts.
   Update checks carry no credentials.
6. **No telemetry.** No analytics, crash reporting, or usage data leaves the machine.
7. **No secrets in the repository.** Credentials, tokens and account snapshots are git-ignored and
   scanned for in CI.
8. **Opt-in only for costly probing.** Reasoning-tier detection sends real (billable) requests and is
   never automatic or batched.

## 4. Do-NOT list (contributions violating these are rejected)

- ❌ Multi-account pooling, account rotation, or account sharing
- ❌ Automated check-in, task-center automation, or any "credit farming"
- ❌ Bypassing billing, rate limits or quotas (including retrying under a different identity during a cooldown)
- ❌ Fabricating a User-Agent newer than, or unrelated to, the locally installed app
- ❌ Sending credentials, tokens or conversation content to any non-upstream host
- ❌ Writing to or tampering with the desktop app's credential files
- ❌ Printing, logging, screenshotting or committing token values
- ❌ Listening on a non-loopback address, or exposing the gateway to others
- ❌ Built-in telemetry or statistics reporting
- ❌ Commercial resale or acting as a proxy for other users
- ❌ Unbounded or automatic reasoning-tier probing
- ❌ Shipping unreviewed third-party gateway binaries

## 5. Handling credentials on your machine

- The app's own logs may contain credentials in plaintext in some builds — do **not** read, copy or
  paste those logs.
- Keep this project's state directory out of cloud sync/backup folders.
- Prefer an OS keychain over plain files for long-lived refresh tokens where available.
- If you ever need to share a diagnostic, share **field names**, never values.

## 6. Reporting security issues

Please report privately (see the repository's security policy) rather than in a public issue, and
never attach real credentials.
