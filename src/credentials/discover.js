// Desktop auth-file discovery.
//
// Precedence: an explicit path (CLI flag or variant environment variable) is
// used verbatim; otherwise a per-platform candidate list is probed in order.
// Both variants share the `CodeBuddyExtension` auth directory and differ only
// by basename.

import { homedir, platform, release } from 'node:os';
import { join, dirname } from 'node:path';

const DESKTOP_AUTH_RELATIVE_PATH = Object.freeze([
  'CodeBuddyExtension',
  'Data',
  'Public',
  'auth',
]);

function dedupe(values) {
  return [...new Set(values)];
}

/** Whether this Linux process runs under Windows Subsystem for Linux. */
export function isWsl(env = process.env, plat = platform(), osRelease = release()) {
  if (plat !== 'linux') return false;
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true;
  return osRelease.toLowerCase().includes('microsoft');
}

function xdgBase(value, fallback) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.startsWith('/') ? trimmed : fallback;
}

function windowsPathForWsl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('/')) return trimmed;
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(trimmed);
  if (drive === null) return undefined;
  return join('/mnt', drive[1].toLowerCase(), ...drive[2].split(/[\\/]+/u));
}

function wslCandidates(home, env) {
  const profile = windowsPathForWsl(env.USERPROFILE) ?? join('/mnt/c/Users', home.split(/[\\/]/u).pop());
  const localAppData = windowsPathForWsl(env.LOCALAPPDATA) ?? join(profile, 'AppData', 'Local');
  const roamingAppData = windowsPathForWsl(env.APPDATA) ?? join(profile, 'AppData', 'Roaming');
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ];
}

/**
 * Platform-default auth directories, in probe order.
 *
 * Windows probes both AppData roots (current builds write under Local, older
 * ones under Roaming). Linux probes both XDG bases (most distributions write
 * under the config home; some vendor builds write under the data home). WSL
 * probes the mounted Windows profile before native Linux locations.
 */
export function defaultAuthDirs({ env = process.env, plat = platform(), home = homedir(), osRelease = release() } = {}) {
  if (plat === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_RELATIVE_PATH)];
  }
  if (plat === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_RELATIVE_PATH),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_RELATIVE_PATH),
    ];
  }
  if (plat === 'linux') {
    const configHome = xdgBase(env.XDG_CONFIG_HOME, join(home, '.config'));
    const dataHome = xdgBase(env.XDG_DATA_HOME, join(home, '.local', 'share'));
    const linux = [
      join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH),
      join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH),
    ];
    return isWsl(env, plat, osRelease)
      ? dedupe([...wslCandidates(home, env), ...linux])
      : dedupe(linux);
  }
  return [];
}

/** Per-variant platform-default auth-file candidates, in probe order. */
export function desktopAuthCandidates(variant, options = {}) {
  return dedupe(defaultAuthDirs(options).map((dir) => join(dir, variant.desktopFilename)));
}

/**
 * Resolve the candidate list for a read: an explicit path wins, then the
 * variant's environment variable, then the platform defaults.
 */
export function resolveDesktopCandidates(variant, { explicitPath, env = process.env, ...rest } = {}) {
  const fromEnv = typeof env[variant.authEnv] === 'string' ? env[variant.authEnv].trim() : '';
  const chosen = explicitPath !== undefined && explicitPath !== ''
    ? explicitPath
    : (fromEnv !== '' ? fromEnv : undefined);
  if (chosen !== undefined) return [chosen];
  return desktopAuthCandidates(variant, { env, ...rest });
}

/** The first candidate, for error messages when nothing was found. */
export function defaultDesktopPath(variant, options) {
  return resolveDesktopCandidates(variant, options)[0];
}

export { DESKTOP_AUTH_RELATIVE_PATH };
