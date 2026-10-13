// Protection of this project's own credential copy (S3 backlog item, SF-6).
//
// The copy used to be plaintext. It is now sealed with AES-256-GCM, and the
// sealing key comes from one of two places, in this order:
//
//   1. **The app's own at-rest key** — the same 32-byte protector key that
//      unwraps the desktop credential envelopes. It is available whenever the
//      desktop file is encrypted (which is the normal state on current builds)
//      and costs nothing extra, because the credential read needs it anyway.
//   2. **An OS key facility** — Windows DPAPI (CurrentUser), macOS Keychain or
//      Linux libsecret. Used when no at-rest key is available in-process, so a
//      plaintext-desktop install still gets a sealed copy.
//
// If neither is available the copy is written as plaintext with an explicit
// warning on the startup log and in docs/security.md. There is no silent
// downgrade: the file records which protection was used, and a file whose
// protection cannot be honoured is reported as `credential-undecryptable`
// instead of being read as "no copy".
//
// Only the *storage* uses the at-rest key; nothing here ever sends a key or a
// credential anywhere. The OS helpers run local system tools with a fixed
// argument list and a timeout.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { platform as osPlatform, userInfo } from 'node:os';
import { keyIdOf } from './at-rest.js';

export const PROTECTION_PLAINTEXT = 'plaintext';
export const PROTECTION_AES_GCM = 'aes-256-gcm';

export const KEY_SOURCE_AT_REST = 'at-rest-key';
export const KEY_SOURCE_NONE = 'none';

/** The AAD binds a sealed own-copy blob to this project and format version. */
export const OWN_COPY_AAD = Buffer.from('pi-workbuddy-connect/own-copy/v2\0', 'utf8');

const OS_KEY_FILENAME = 'own-copy.key';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const OS_HELPER_TIMEOUT_MS = 10_000;
const OS_HELPER_MAX_OUTPUT = 64 * 1024;
const KEYCHAIN_SERVICE = 'pi-workbuddy-connect';
const KEYCHAIN_ACCOUNT_LABEL = 'own-copy';
const SECRET_TOOL_LABEL = 'pi-workbuddy-connect own credential copy';

/** The OS key facility this platform uses, or undefined when there is none. */
export function osKeySourceFor(plat = osPlatform()) {
  if (plat === 'win32') return 'os-dpapi';
  if (plat === 'darwin') return 'os-keychain';
  if (plat === 'linux') return 'os-libsecret';
  return undefined;
}

/** A value-free description of an OS key facility, for logs and diagnostics. */
export function describeOsKeySource(source) {
  if (source === 'os-dpapi') return 'Windows DPAPI (CurrentUser)';
  if (source === 'os-keychain') return 'macOS Keychain';
  if (source === 'os-libsecret') return 'Linux libsecret';
  return undefined;
}

/**
 * Seal a plaintext credential with a 32-byte key.
 * @returns {{ protection: string, keyId: string, nonce: string, authTag: string, ciphertext: string }}
 */
export function sealCredential(plaintext, key) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(OWN_COPY_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    protection: PROTECTION_AES_GCM,
    keyId: keyIdOf(key),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Open a sealed credential; undefined when the key is wrong or the blob is damaged. */
export function openCredential(sealed, key) {
  if (sealed?.protection !== PROTECTION_AES_GCM) return undefined;
  try {
    const nonce = Buffer.from(sealed.nonce, 'base64');
    const authTag = Buffer.from(sealed.authTag, 'base64');
    const ciphertext = Buffer.from(sealed.ciphertext, 'base64');
    if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(OWN_COPY_AAD);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The result shape every OS runner returns. */
function runProcess(file, args, { input, timeoutMs = OS_HELPER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: OS_HELPER_MAX_OUTPUT, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error });
      },
    );
    if (input !== undefined && child.stdin !== null) {
      child.stdin.end(input);
    }
  });
}

/** UTF-16LE base64, the encoding `powershell.exe -EncodedCommand` expects. */
function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** A DPAPI PowerShell snippet: protect or unprotect a base64 blob as the current user. */
export function dpapiScript(mode, payload) {
  const call = mode === 'protect' ? 'Protect' : 'Unprotect';
  return [
    "$ErrorActionPreference='Stop'",
    "try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch { }",
    `$b=[Convert]::FromBase64String('${payload}')`,
    `$o=[System.Security.Cryptography.ProtectedData]::${call}($b,$null,'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($o))',
  ].join('; ');
}

/**
 * A per-platform key store for the own copy. All process execution goes through
 * the injected `run`, so the unit tests never touch a real OS facility.
 *
 * @param {{ plat?: string, dir: string, run?: typeof runProcess, env?: object }} options
 * @returns {{ source: string|undefined, describe: () => string|undefined,
 *   available: () => boolean, load: () => Promise<Buffer|undefined>, store: (key: Buffer) => Promise<boolean> }}
 */
export function createOsKeyStore({ plat = osPlatform(), dir, run = runProcess, env = process.env } = {}) {
  const source = osKeySourceFor(plat);
  const keyFile = join(dir, OS_KEY_FILENAME);

  async function runDpapi(mode, payload) {
    const powershell = plat === 'win32' ? (env.SystemRoot === undefined
      ? 'powershell.exe'
      : join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) : 'powershell.exe';
    return run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShell(dpapiScript(mode, payload)),
    ]);
  }

  async function runKeychain(mode, payload) {
    if (mode === 'protect') {
      return run('/usr/bin/security', [
        'add-generic-password',
        '-U',
        '-a', KEYCHAIN_ACCOUNT_LABEL,
        '-s', KEYCHAIN_SERVICE,
        '-w', payload,
      ]);
    }
    return run('/usr/bin/security', [
      'find-generic-password',
      '-a', KEYCHAIN_ACCOUNT_LABEL,
      '-s', KEYCHAIN_SERVICE,
      '-w',
    ]);
  }

  async function runLibsecret(mode, payload) {
    if (mode === 'protect') {
      return run('/usr/bin/secret-tool', [
        'store',
        `--label=${SECRET_TOOL_LABEL}`,
        'service', KEYCHAIN_SERVICE,
        'key', KEYCHAIN_ACCOUNT_LABEL,
      ], { input: `${payload}\n` });
    }
    return run('/usr/bin/secret-tool', [
      'lookup',
      'service', KEYCHAIN_SERVICE,
      'key', KEYCHAIN_ACCOUNT_LABEL,
    ]);
  }

  const dispatch = source === 'os-dpapi'
    ? runDpapi
    : source === 'os-keychain'
      ? runKeychain
      : source === 'os-libsecret'
        ? runLibsecret
        : undefined;

  /** Decode a helper answer into a 32-byte key, or undefined. */
  function decodeKey(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return undefined;
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length !== KEY_BYTES || decoded.every((byte) => byte === 0)) return undefined;
    return decoded;
  }

  return {
    source,
    describe: () => describeOsKeySource(source),
    available: () => dispatch !== undefined,
    /** Load the stored key. DPAPI reads a file; Keychain/libsecret are queried. */
    async load() {
      if (dispatch === undefined) return undefined;
      if (source === 'os-dpapi') {
        let wrapped;
        try {
          wrapped = readFileSync(keyFile, 'utf8').trim();
        } catch (error) {
          if (error?.code === 'ENOENT') return undefined;
          return undefined;
        }
        if (wrapped === '') return undefined;
        const result = await runDpapi('unprotect', wrapped);
        if (!result.ok) return undefined;
        return decodeKey(result.stdout);
      }
      const result = await dispatch('unprotect', '');
      if (!result.ok) return undefined;
      return decodeKey(result.stdout);
    },
    /** Store a key, generating one when none was given. Returns false when unusable. */
    async store(key) {
      if (dispatch === undefined) return false;
      const material = key ?? randomBytes(KEY_BYTES);
      const payload = material.toString('base64');
      if (source === 'os-dpapi') {
        const result = await runDpapi('protect', payload);
        if (!result.ok) return false;
        const wrapped = result.stdout.trim();
        if (wrapped === '') return false;
        writeFileSync(keyFile, `${wrapped}\n`, { mode: 0o600 });
        if (plat !== 'win32') {
          try {
            chmodSync(keyFile, 0o600);
          } catch {
            /* best effort */
          }
        }
        return true;
      }
      const result = await dispatch('protect', payload);
      return result.ok;
    },
    remove() {
      rmSync(keyFile, { force: true });
    },
    userLabel: userInfo().username,
  };
}

export { runProcess as defaultRunProcess };
