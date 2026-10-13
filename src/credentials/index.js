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
import { keyIdsOf, classifyAuthDocument, openField, protectorKeysFromPayload, unwrapDocument } from './at-rest.js';
import { loadAtRestPayload, resolveElectronBinary } from './electron.js';
import { parseAuthDocument, parseOwnDocument } from './document.js';
import { readOwn, removeOwn } from './store.js';

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

export class CredentialStore {
  /**
   * @param {object} options
   * @param {import('../variant.js').VARIANTS.cn} options.variant
   * @param {string} [options.authFile] explicit desktop path
   * @param {string} [options.electronPath] explicit Electron binary
   * @param {object} [options.env]
   * @param {string} [options.ownDir]
   * @param {(path: string) => Promise<string>} [options.fileReader]
   * @param {(path: string) => string|undefined} [options.ownReader]
   */
  constructor(options) {
    this.variant = options.variant;
    this.authFile = options.authFile;
    this.env = options.env ?? process.env;
    this.ownDir = options.ownDir ?? ownStateDir(this.env);
    this.fileReader = options.fileReader ?? ((filePath) => readFile(filePath, 'utf8'));
    this.ownReader = options.ownReader ?? readOwn;
    this.keyProvider = new ProtectorKeyProvider({
      variant: options.variant,
      electronPath: options.electronPath,
      env: this.env,
      run: options.run,
      readAtRest: options.readAtRest,
    });
    this.lastElectronPath = undefined;
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

  /** Read the project-owned copy (never refreshes). */
  readOwnCopy() {
    return this.ownReader(this.ownPath);
  }

  /**
   * The effective credential: desktop and own copy merged, with a hard region
   * check against the selected variant.
   */
  async current() {
    const desktop = await this.readDesktop();
    const own = this.readOwnCopy();

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

    if (desktop === undefined && own === undefined) return undefined;
    if (desktop === undefined) return { credential: own, source: 'own-copy', format: 'plaintext' };
    const base = { ...desktop, format: desktop.format };
    if (own === undefined) return { ...base, credential: desktop.credential, source: 'desktop' };

    const sameIdentity = desktop.credential.uid === own.uid && desktop.credential.enterpriseId === own.enterpriseId;
    if (!sameIdentity) return { ...base, credential: desktop.credential, source: 'desktop' };
    const useOwn = own.expiresAtMs > desktop.credential.expiresAtMs;
    return { ...base, credential: useOwn ? own : desktop.credential, source: useOwn ? 'own-copy' : 'desktop' };
  }

  /** Remove the project-owned copy. The desktop file is untouched. */
  removeOwnCopy() {
    return removeOwn(this.ownPath);
  }
}
