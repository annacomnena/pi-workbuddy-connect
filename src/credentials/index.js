// Credential resolution: discover, read, unwrap, merge.
//
// The desktop app's file is the identity authority and is never written. A
// project-owned copy holds refreshes. The two are merged only when they belong
// to the same account; otherwise the desktop file wins, because it is the one
// the app itself keeps current.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REASON, WbError } from '../errors.js';
import { regionOfDomain } from '../upstream/domains.js';
import { ownStateDir } from '../paths.js';
import { resolveDesktopCandidates } from './discover.js';
import {
  keyIdOf,
  keyIdsOf,
  classifyAuthDocument,
  openField,
  protectorKeysFromPayload,
  unwrapDocument,
} from './at-rest.js';
import { loadAtRestPayload, resolveElectronBinary } from './electron.js';
import { parseAuthDocument } from './document.js';
import { readOwn, writeOwn, removeOwn, ownFileMode } from './store.js';
import { KEY_SOURCE_AT_REST, KEY_SOURCE_NONE, createOsKeyStore, sealCredential } from './protection.js';

/** The key payload plus where the binary came from, for diagnostics. */
class ProtectorKeyProvider {
  #cache;
  #inflight;

  constructor({ variant, electronPath, env, run, readAtRest }) {
    this.variant = variant;
    this.electronPath = electronPath;
    this.env = env;
    this.run = run;
    this.readAtRest = readAtRest ?? loadAtRestPayload;
  }

  /** Resolve the binary without running it (diagnostics). */
  async binary() {
    if (this.#cache !== undefined) return { path: this.#cache.electronPath, source: this.#cache.source };
    return resolveElectronBinary(this.variant, { explicitPath: this.electronPath, env: this.env, run: this.run });
  }

  /** Resolve and run the helper at most once per instance. */
  async keys() {
    if (this.#cache !== undefined) return this.#cache;
    this.#inflight ??= (async () => {
      const resolved = await resolveElectronBinary(this.variant, {
        explicitPath: this.electronPath,
        env: this.env,
        run: this.run,
      });
      const stdout = await this.readAtRest(resolved.path);
      const keys = protectorKeysFromPayload(stdout);
      if (keys === undefined) {
        throw new WbError(
          REASON.credentialUndecryptable,
          `${this.variant.appName} returned an unusable at-rest payload (expected {version:1, atRestSecretKey})`,
        );
      }
      this.#cache = { ...keys, electronPath: resolved.path, source: resolved.source };
      return this.#cache;
    })().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }
}

/**
 * Resolves the key that protects this project's own credential copy (SF-6).
 *
 * Sealing prefers the app's own at-rest key, because that key is already needed
 * to read the desktop credential and costs no extra step. When it cannot be
 * produced (plaintext desktop install, no app), an OS key facility is used.
 * When neither exists, the copy is written as plaintext and the caller is told
 * so explicitly -- there is no silent downgrade.
 */
class OwnCopyProtector {
  #degradedWarned = false;

  constructor({ keyProvider, osKeyStore, logger }) {
    this.keyProvider = keyProvider;
    this.osKeyStore = osKeyStore;
    this.logger = logger;
  }

  /** The app's at-rest key, or undefined when it cannot be produced. */
  async #atRestKey() {
    try {
      const keys = await this.keyProvider.keys();
      return keys.key;
    } catch {
      return undefined;
    }
  }

  /** A key held by the OS facility, creating one on first use. */
  async #osKey() {
    const store = this.osKeyStore;
    if (store === undefined || !store.available()) return undefined;
    try {
      const existing = await store.load();
      if (existing !== undefined) return existing;
      if (!(await store.store(undefined))) return undefined;
      return await store.load();
    } catch {
      return undefined;
    }
  }

  /** Seal the serialized credential; reports the key source or the degradation. */
  async seal(text) {
    const atRestKey = await this.#atRestKey();
    if (atRestKey !== undefined) {
      return { sealed: sealCredential(text, atRestKey), keySource: KEY_SOURCE_AT_REST };
    }
    const osKey = await this.#osKey();
    if (osKey !== undefined) {
      return { sealed: sealCredential(text, osKey), keySource: this.osKeyStore.source };
    }
    const degraded = {
      reason: 'no-protection-available',
      message: 'neither the app at-rest key nor an OS key facility is available; the credential copy is stored as plaintext',
    };
    // A runtime degradation must not be silent: the startup warning only covers
    // the case where both were already known to be missing.
    if (this.#degradedWarned !== true) {
      this.#degradedWarned = true;
      this.logger?.warn?.(`SF-6 DEGRADED at runtime: ${degraded.message}. See docs/security.md.`);
    }
    return { keySource: KEY_SOURCE_NONE, degraded };
  }

  /** Produce the key a stored record needs, or undefined when it is unavailable. */
  async openKey(record) {
    if (record.keySource === KEY_SOURCE_AT_REST) {
      const key = await this.#atRestKey();
      if (key === undefined) return undefined;
      if (typeof record.keyId === 'string' && record.keyId !== '' && keyIdOf(key) !== record.keyId) return undefined;
      return key;
    }
    if (this.osKeyStore !== undefined && record.keySource === this.osKeyStore.source) {
      return await this.#osKey();
    }
    return undefined;
  }
}

export class CredentialStore {
  /**
   * @param {object} options
   * @param {import('../variant.js').VARIANTS.cn} options.variant
   * @param {string} [options.authFile] explicit desktop path
   * @param {string} [options.electronPath] explicit Electron binary
   * @param {object} [options.env]
   * @param {string} [options.ownDir]
   * @param {(path: string) => Promise<string>} [options.fileReader]
   * @param {object} [options.osKeyStore] injectable OS key facility (tests)
   * @param {'win32'|'darwin'|'linux'} [options.plat] platform override (tests)
   * @param {Function} [options.runOsHelper] process runner for the OS facility (tests)
   * @param {object} [options.logger] warns when a copy write degrades at runtime (SF-3)
   */
  constructor(options) {
    this.variant = options.variant;
    this.authFile = options.authFile;
    this.env = options.env ?? process.env;
    this.ownDir = options.ownDir ?? ownStateDir(this.env);
    this.fileReader = options.fileReader ?? ((filePath) => readFile(filePath, 'utf8'));
    this.keyProvider = new ProtectorKeyProvider({
      variant: options.variant,
      electronPath: options.electronPath,
      env: this.env,
      run: options.run,
      readAtRest: options.readAtRest,
    });
    this.osKeyStore = options.osKeyStore ?? createOsKeyStore({
      dir: this.ownDir,
      plat: options.plat,
      env: this.env,
      run: options.runOsHelper,
    });
    this.protector = new OwnCopyProtector({ keyProvider: this.keyProvider, osKeyStore: this.osKeyStore, logger: options.logger });
    this.lastElectronPath = undefined;
    /** The last own-copy protection actually used (for /healthz and reports). */
    this.lastProtection = undefined;
    /** A failure while reading the own copy; never collapsed into "no copy". */
    this.lastOwnCopyError = undefined;
  }

  get ownPath() {
    return join(this.ownDir, this.variant.ownFilename);
  }

  desktopCandidates() {
    return resolveDesktopCandidates(this.variant, { explicitPath: this.authFile, env: this.env });
  }

  /**
   * Read the first desktop candidate that exists and carries content.
   * @returns {Promise<{ path: string, text: string } | undefined>}
   */
  async readDesktopText() {
    for (const candidate of this.desktopCandidates()) {
      let text;
      try {
        text = await this.fileReader(candidate);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new WbError(REASON.credentialUnreadable, `could not read the desktop auth file (${error?.code ?? 'error'})`, { cause: error });
      }
      if (text.trim() === '') continue;
      return { path: candidate, text };
    }
    return undefined;
  }

  /**
   * Describe the desktop document without decrypting anything (diagnostics).
   * @returns {Promise<{ path: string|undefined, format: 'absent'|'plaintext'|'unrecognized'|'encrypted' }>}
   */
  async classifyDesktop() {
    const found = await this.readDesktopText();
    if (found === undefined) return { path: this.desktopCandidates()[0], format: 'absent' };
    return { path: found.path, format: classifyAuthDocument(found.text).format };
  }

  /**
   * Read the desktop credential, unwrapping envelopes when present.
   * @returns {Promise<{ credential: import('./document.js').Credential, format: string, path: string,
   *   keyId?: string, keyIdMatched?: boolean, electronSource?: string } | undefined>}
   */
  async readDesktop() {
    const found = await this.readDesktopText();
    if (found === undefined) return undefined;
    const classification = classifyAuthDocument(found.text);
    if (classification.format === 'plaintext') {
      const credential = parseAuthDocument(JSON.parse(found.text), 'desktop');
      if (credential === undefined) {
        throw new WbError(REASON.credentialUnreadable, 'the desktop auth file carries no access token');
      }
      return { credential, format: 'plaintext', path: found.path };
    }
    if (classification.format === 'unrecognized') {
      throw new WbError(
        REASON.credentialUnreadable,
        'the desktop auth file exists but is neither a plaintext credential nor a decodable envelope; fix or remove the file',
      );
    }
    // Encrypted: unwrap. Failure here must never read as "not signed in".
    const envelopeKeyIds = keyIdsOf(classification.wrapped.fields);
    const keys = await this.keyProvider.keys();
    this.lastElectronPath = keys.electronPath;
    const keyIdMatched = envelopeKeyIds.includes(keys.keyId);
    let failedField;
    const rebuilt = unwrapDocument(classification, (field, envelope) => {
      const plaintext = openField(keys.key, envelope);
      if (plaintext === undefined) {
        failedField ??= field;
        return '';
      }
      return plaintext;
    });
    if (failedField !== undefined) {
      throw new WbError(
        REASON.credentialUndecryptable,
        keyIdMatched
          ? `the encrypted desktop credential's ${failedField} could not be decrypted; open the ${this.variant.appName} app once to reseal the sign-in`
          : `the desktop credential is sealed by a different installation (envelope key ids ${envelopeKeyIds
            .map((id) => id.slice(0, 4))
            .join(', ')}\u2026 do not match this app's key)`,
        { detail: { keyIdMatched } },
      );
    }
    const credential = parseAuthDocument(rebuilt, 'desktop');
    if (credential === undefined) {
      throw new WbError(REASON.credentialUnreadable, 'the decrypted desktop credential carries no access token');
    }
    return {
      credential,
      format: 'encrypted',
      path: found.path,
      keyId: keys.keyId,
      keyIdMatched,
      electronSource: keys.source,
    };
  }

  /** Read the project-owned copy, opening it when sealed. Never refreshes. */
  async readOwnCopy() {
    try {
      const record = await readOwn(this.ownPath, { openKey: (opened) => this.protector.openKey(opened) });
      this.lastOwnCopyError = undefined;
      if (record !== undefined) {
        this.lastProtection = {
          protection: record.protection,
          keySource: record.keySource,
          legacy: record.legacy === true,
        };
      }
      return record?.credential;
    } catch (error) {
      this.lastOwnCopyError = error;
      return undefined;
    }
  }

  /** Write the project-owned copy with its at-rest protection (SF-6). */
  async writeOwnCopy(credential) {
    const result = await writeOwn(this.ownPath, credential, { protector: this.protector });
    this.lastProtection = {
      protection: result.keySource === KEY_SOURCE_NONE ? 'plaintext' : 'aes-256-gcm',
      keySource: result.keySource,
      ...(result.degraded === undefined ? {} : { degraded: result.degraded }),
    };
    return result;
  }

  /**
   * The effective credential: desktop and own copy merged, with a hard region
   * check against the selected variant.
   */
  async current() {
    const desktop = await this.readDesktop();
    const own = await this.readOwnCopy();

    const checkRegion = (credential, label) => {
      const region = regionOfDomain(credential.domain);
      if (region !== this.variant.region) {
        throw new WbError(
          REASON.credentialRegionMismatch,
          `${this.variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential in its ${label}; point ${this.variant.authEnv} at the matching sign-in`,
        );
      }
    };
    if (desktop !== undefined) checkRegion(desktop.credential, 'desktop file');
    if (own !== undefined) checkRegion(own, 'project copy');

    if (desktop === undefined && own === undefined) {
      // A copy that exists but cannot be opened must not read as "not signed in".
      if (this.lastOwnCopyError !== undefined) throw this.lastOwnCopyError;
      return undefined;
    }
    if (desktop === undefined) {
      return { credential: own, source: 'own-copy', format: 'plaintext' };
    }
    const base = { ...desktop, format: desktop.format };
    if (own === undefined) return { ...base, credential: desktop.credential, source: 'desktop' };

    const sameIdentity = desktop.credential.uid === own.uid && desktop.credential.enterpriseId === own.enterpriseId;
    if (!sameIdentity) return { ...base, credential: desktop.credential, source: 'desktop' };
    const useOwn = own.expiresAtMs > desktop.credential.expiresAtMs;
    return { ...base, credential: useOwn ? own : desktop.credential, source: useOwn ? 'own-copy' : 'desktop' };
  }

  /** Remove the project-owned copy (logout). The desktop file is untouched. */
  removeOwnCopy() {
    return removeOwn(this.ownPath);
  }
}
