# Third-party notices

This project implements a wire/storage protocol that was **observed** from the local app and from a
public, MIT-licensed reference implementation. It was **not** developed from leaked or proprietary
source.

**Accurate scope of reuse.** Most of this repository is an independent re-expression of the observed
behaviour, but a small number of items are **verbatim interoperability facts** — they cannot be
changed without breaking compatibility with credentials and endpoints the app already produces, and
they therefore match the reference implementation exactly:

- the **AAD frame layout** for a field envelope (`WB-AAD\0` prefix, length-prefixed `WBEV1`/`sym-v1`
  tags, suite number, key id, fixed trailer) and the envelope field names
  (`$wbEncrypted` / `suite` / `keyId` / `nonce` / `authTag` / `ciphertext`);
- the **one-shot helper invocation** used to ask the app for its at-rest key
  (`ELECTRON_RUN_AS_NODE=1` plus
  `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()`);
- the **helper payload shape** (`{version: 1, atRestSecretKey}`) and the key-id derivation
  (`sha256(key).hex().slice(0, 16)`).

These are protocol constants, not separable creative code. Where they appear in this repository
(`src/credentials/at-rest.js`, `src/credentials/electron.js`) the file header carries the upstream
attribution below, as promised in `README.md`. Everything else here — control flow, validation,
discovery, CLI, redaction, tests — is an independent re-expression of the same observed behaviour.

## Acknowledgements

- [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT, Copyright (c)
  2026 Corrine Hu) — a public, MIT-licensed reference implementation of the same private upstream
  interface. It informed the research notes (`docs/mechanism.md`, `docs/protocol.md`) as an
  *observation source* for endpoint paths, field names, header families and error classes, and the
  verbatim protocol facts listed above are derived from it.
- `Sliverkiss/workbuddy2api` (MIT) — cited upstream by the reference implementation as the origin of
  parts of its wire behaviour. No code from this project is included here.

### Upstream licence text

The following licence and copyright notice are reproduced because this repository reuses the
verbatim protocol facts described above:

```
MIT License

Copyright (c) 2026 Corrine Hu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Generated test fixtures

All tests use **self-made fixtures**: a locally generated random secret, a locally built envelope,
and obviously fake credential strings (`fixture-*`). No real credential is read, copied, or
committed.

MIT is a licence for software, not for any third-party service, trademark, or API. See
[`docs/compliance.md`](docs/compliance.md).
