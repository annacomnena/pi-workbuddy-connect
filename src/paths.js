// Where this project keeps its own state.
//
// The desktop app's auth file is only ever read. Anything this tool writes —
// a refreshed credential copy, a saved catalog — goes to a project-owned
// directory with owner-only permissions.

import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export const PROJECT_DIR_NAME = 'pi-workbuddy-connect';

/** The project-owned state directory for the current platform. */
export function ownStateDir(env = process.env, plat = platform(), home = homedir()) {
  if (plat === 'win32') {
    const appData = typeof env.APPDATA === 'string' && env.APPDATA.trim() !== ''
      ? env.APPDATA
      : join(home, 'AppData', 'Roaming');
    return join(appData, PROJECT_DIR_NAME);
  }
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', PROJECT_DIR_NAME);
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME.trim() : '';
  const base = xdg.startsWith('/') ? xdg : join(home, '.local', 'state');
  return join(base, PROJECT_DIR_NAME);
}

/** Create the project-owned directory (and parents) with owner-only mode. */
export function ensureOwnDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Render a path for display with the home directory folded to `~`, so output
 * pasted into a public report never carries the local user name.
 */
export function displayPath(filePath, home = homedir()) {
  if (typeof filePath !== 'string' || filePath === '') return filePath;
  const norm = (value) => value.replace(/[\\/]+$/u, '');
  const h = norm(home);
  if (filePath === h) return '~';
  for (const sep of ['\\', '/']) {
    const prefix = `${h}${sep}`;
    if (filePath.toLowerCase().startsWith(prefix.toLowerCase())) {
      return `~${sep}${filePath.slice(prefix.length)}`;
    }
  }
  // Windows paths may differ in casing between homedir() and the env-provided root.
  const lower = filePath.toLowerCase();
  const lowerH = h.toLowerCase();
  if (lower.startsWith(lowerH) && /[\\/]/u.test(filePath.charAt(h.length))) {
    return `~${filePath.slice(h.length)}`;
  }
  return filePath;
}

/** The directory a file lives in, for reporting only. */
export function parentDirOf(filePath) {
  try {
    return dirname(filePath);
  } catch {
    return filePath;
  }
}
