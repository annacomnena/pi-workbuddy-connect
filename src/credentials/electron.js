// Locating the app's Electron binary, and asking it for the at-rest key.
//
// The at-rest key is not derivable offline. The only supported source is the
// app's own binary, run in Node mode, calling its internal storage binding and
// printing the payload. This module resolves *which* binary that is, under a
// strict contract, and runs it with a timeout and an output cap.
//
// Protocol facts derived from dsh-workbuddy-connect (MIT, (c) 2026 Corrine Hu):
// the one-shot helper invocation -- ELECTRON_RUN_AS_NODE=1 plus
// process._linkedBinding("electron_browser_workbuddy_storage").loggerGet() -- is
// reproduced verbatim because that exact binding name and call are the only
// interoperable way to reach the app's at-rest key. Everything else in this
// file is an independent re-expression.
//
// Resolution order (an explicit path never falls back):
//   1. explicit path (CLI flag or the variant's Electron environment variable)
//   2. platform default (Windows: `%LOCALAPPDATA%\Programs\<app>`; macOS: the
//      known bundle path)
//   3. discovery (Windows: uninstall registry; macOS: Spotlight + plutil)
//
// "We could not tell" is a distinct outcome from "the app is not there", and is
// reported as such.

import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { REASON, WbError } from '../errors.js';

/** Runs inside the app's Electron as plain Node; prints only the payload. */
export const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

export const HELPER_ARGUMENT_FLAG = '-e';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DISCOVERY_BUDGET_MS = 10_000;
const WINDOWS_REGISTRY_STEP_TIMEOUT_MS = 10_000;
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const REG_KEY_LINE = /^HKEY_[A-Z_]+\\/u;

function isEnoent(error) {
  return error?.code === 'ENOENT';
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a candidate against the known Electron layout for the platform.
 * `undefined` is a decidable exclusion; `'unresolved'` means the check itself
 * could not complete and must not be read as "absent".
 */
export function inspectWindowsCandidate(candidate, exeBasename, plat = 'win32') {
  if (plat !== 'win32' || basename(candidate).toLowerCase() !== exeBasename) return undefined;
  let stat;
  try {
    stat = statSync(candidate);
  } catch (error) {
    return isEnoent(error) ? undefined : 'unresolved';
  }
  if (!stat.isFile()) return undefined;
  try {
    accessSync(candidate, constants.X_OK);
  } catch (error) {
    return isEnoent(error) ? undefined : 'unresolved';
  }
  const installRoot = dirname(candidate);
  let version;
  try {
    version = readFileSync(join(installRoot, 'version'), 'utf8').trim();
  } catch (error) {
    return isEnoent(error) ? undefined : 'unresolved';
  }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined;
  try {
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined;
  } catch (error) {
    return isEnoent(error) ? undefined : 'unresolved';
  }
  let identity;
  try {
    identity = realpathSync(candidate).toLowerCase();
  } catch (error) {
    return isEnoent(error) ? undefined : 'unresolved';
  }
  return { electronPath: candidate, identity };
}

/** Parse a quoted `DisplayIcon` value and strip the Windows icon-index suffix. */
export function parseWindowsDisplayIcon(value) {
  const raw = String(value ?? '').trim();
  let filePath;
  if (raw.startsWith('"')) {
    const closing = raw.indexOf('"', 1);
    if (closing < 0) return undefined;
    filePath = raw.slice(1, closing);
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw);
    if (match === null) return undefined;
    filePath = match[1];
  }
  filePath = filePath.trim();
  return /\.exe$/iu.test(filePath) ? filePath : undefined;
}

/**
 * Parse `reg.exe query <root> /s` output into candidate `DisplayIcon` paths
 * whose registry key also carries a matching `DisplayName`.
 */
export function parseRegUninstallOutput(text, displayNamePattern) {
  const candidates = [];
  let current = { displayName: undefined, displayIcon: undefined };
  const flush = () => {
    if (
      current.displayIcon !== undefined
      && current.displayName !== undefined
      && displayNamePattern.test(current.displayName)
    ) {
      const parsed = parseWindowsDisplayIcon(current.displayIcon);
      if (parsed !== undefined) candidates.push(parsed);
    }
    current = { displayName: undefined, displayIcon: undefined };
  };
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (REG_KEY_LINE.test(line.trim())) {
      flush();
      continue;
    }
    const match = /^\s+(DisplayName|DisplayIcon)\s+REG_SZ\s+(.*)$/u.exec(line);
    if (match === null) continue;
    if (match[1] === 'DisplayName') current.displayName = match[2].trim();
    else current.displayIcon = match[2].trim();
  }
  flush();
  return candidates;
}

/** Run a tool with a timeout and an output cap; rejects with a tagged error. */
export function runTool(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** The 32-bit uninstall registry roots, in probe order. */
export const WINDOWS_REGISTRY_ROOTS = Object.freeze([
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]);

/** The platform default path for a variant, when one is known. */
export function defaultElectronPath(variant, { env = process.env, plat = osPlatform() } = {}) {
  if (plat === 'darwin') return variant.macOS.defaultPath;
  if (plat !== 'win32' || variant.windows.defaultPathSegments === undefined) return undefined;
  const localAppData = typeof env.LOCALAPPDATA === 'string' ? env.LOCALAPPDATA.trim() : '';
  if (localAppData === '') return undefined;
  return join(localAppData, ...variant.windows.defaultPathSegments);
}

async function discoverWindowsApp(variant, { run = runTool, plat = osPlatform() } = {}) {
  const seen = new Map();
  let unresolved = false;
  const candidates = [];
  for (const root of WINDOWS_REGISTRY_ROOTS) {
    let output;
    try {
      output = await run('reg.exe', ['query', root, '/s'], {
        timeoutMs: WINDOWS_REGISTRY_STEP_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      // A completely missing reg.exe is "cannot check"; an absent root is normal.
      if (isEnoent(error)) unresolved = true;
      else if (/unable to find/i.test(String(error?.stdout ?? ''))) { /* root absent */ }
      else unresolved = true;
      continue;
    }
    candidates.push(...parseRegUninstallOutput(output, variant.windows.displayNamePattern));
  }
  for (const candidate of new Set(candidates)) {
    const inspection = inspectWindowsCandidate(candidate, variant.windows.exeBasename, plat);
    if (inspection === 'unresolved') {
      unresolved = true;
      continue;
    }
    if (inspection === undefined) continue;
    seen.set(inspection.identity, inspection.electronPath);
  }
  if (seen.size > 1) {
    throw new WbError(
      REASON.electronNotFound,
      `more than one ${variant.appName} installation was found; set ${variant.electronEnv} to the one to use`,
      { detail: { candidates: seen.size } },
    );
  }
  if (seen.size === 1) return [...seen.values()][0];
  if (unresolved) {
    throw new WbError(
      REASON.electronDiscoveryIncomplete,
      `the ${variant.appName} application search did not finish; this is not proof that the app is missing`,
    );
  }
  throw new WbError(
    REASON.electronNotFound,
    `no ${variant.appName} Electron binary was found in the default location or Windows uninstall records; set ${variant.electronEnv} to the installed app's executable`,
  );
}

async function discoverMacosApp(variant, { run = runTool, plat = osPlatform() } = {}) {
  if (plat !== 'darwin') {
    throw new WbError(REASON.electronNotFound, `no ${variant.appName} Electron binary is configured for this platform`);
  }
  let listing;
  try {
    listing = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${variant.macOS.bundleId}'`]);
  } catch {
    throw new WbError(
      REASON.electronDiscoveryIncomplete,
      `the ${variant.appName} application search did not complete; this is not proof that the app is missing`,
    );
  }
  const bundles = listing.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.app'));
  const seen = new Set();
  for (const bundle of bundles) {
    let identifier;
    try {
      identifier = (await run('/usr/bin/plutil', [
        '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist'),
      ])).trim();
    } catch {
      continue;
    }
    if (identifier !== variant.macOS.bundleId) continue;
    const binary = join(bundle, 'Contents', 'MacOS', 'Electron');
    if (isExecutable(binary)) seen.add(realpathSync(binary));
  }
  if (seen.size > 1) {
    throw new WbError(
      REASON.electronNotFound,
      `more than one ${variant.appName} installation was found; set ${variant.electronEnv} to the one to use`,
    );
  }
  if (seen.size === 0) {
    throw new WbError(
      REASON.electronNotFound,
      `no ${variant.appName} application was found; set ${variant.electronEnv} to the app's Electron binary`,
    );
  }
  return [...seen.values()][0];
}

/**
 * Resolve the Electron binary to run.
 * @returns {Promise<{ path: string, source: 'explicit' | 'env' | 'default' | 'discovery' }>}
 */
export async function resolveElectronBinary(variant, options = {}) {
  const {
    explicitPath,
    env = process.env,
    plat = osPlatform(),
    run = runTool,
  } = options;

  const fromEnv = typeof env[variant.electronEnv] === 'string' ? env[variant.electronEnv].trim() : '';
  const configured = explicitPath !== undefined && explicitPath !== '' ? explicitPath : (fromEnv !== '' ? fromEnv : undefined);
  if (configured !== undefined) {
    if (!isExecutable(configured)) {
      throw new WbError(
        REASON.electronNotFound,
        `the configured ${variant.appName} Electron binary is not available; check --electron / ${variant.electronEnv}`,
      );
    }
    return { path: configured, source: explicitPath !== undefined && explicitPath !== '' ? 'explicit' : 'env' };
  }

  const fallback = defaultElectronPath(variant, { env, plat });
  if (fallback !== undefined && isExecutable(fallback)) return { path: fallback, source: 'default' };

  const discovered = plat === 'darwin'
    ? await discoverMacosApp(variant, { run, plat })
    : await discoverWindowsApp(variant, { run, plat });
  return { path: discovered, source: 'discovery' };
}

/** Ask the resolved binary for the at-rest payload (stdout only). */
export function loadAtRestPayload(electronPath, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      [HELPER_ARGUMENT_FLAG, HELPER_SCRIPT],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          // The binary resolved and was run; it is the *unwrapping* that failed.
          // Reporting `electron-not-found` here contradicted doctor's own
          // `electron-binary=pass` check. `electron-not-found` is reserved for
          // resolveElectronBinary's resolution failure path only.
          reject(new WbError(
            REASON.credentialUndecryptable,
            `the ${basename(electronPath)} key helper failed (${error.killed === true ? 'timed out' : 'non-zero exit'}); the app may be mid-update`,
            { cause: error },
          ));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Extract the version token from a registry `DisplayName` such as `WorkBuddy 5.7.7`. */
export function versionFromDisplayName(displayName) {
  const match = /\s(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)$/u.exec(String(displayName ?? '').trim());
  return match === null ? undefined : match[1];
}

/**
 * The locally installed app version, for the User-Agent. Returns undefined
 * when it cannot be determined; callers must not invent a version (risk R3).
 */
export async function resolveAppVersion(variant, { plat = osPlatform(), run = runTool } = {}) {
  if (plat === 'win32') {
    for (const root of WINDOWS_REGISTRY_ROOTS) {
      let output;
      try {
        output = await run('reg.exe', ['query', root, '/s'], {
          timeoutMs: WINDOWS_REGISTRY_STEP_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
        });
      } catch {
        continue;
      }
      const versions = [];
      for (const line of output.split(/\r?\n/u)) {
        const match = /^\s+DisplayName\s+REG_SZ\s+(.*)$/u.exec(line);
        if (match === null) continue;
        const name = match[1].trim();
        if (!variant.windows.displayNamePattern.test(name)) continue;
        const version = versionFromDisplayName(name);
        if (version !== undefined) versions.push(version);
      }
      if (versions.length === 1) return versions[0];
    }
    return undefined;
  }
  if (plat === 'darwin') {
    try {
      const listing = await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${variant.macOS.bundleId}'`]);
      const bundle = listing.split('\n').map((line) => line.trim()).find((line) => line.endsWith('.app'));
      if (bundle === undefined) return undefined;
      const version = (await run('/usr/bin/plutil', [
        '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist'),
      ])).trim();
      return version === '' ? undefined : version;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
