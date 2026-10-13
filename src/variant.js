// The two WorkBuddy variants (CN / Global).
//
// Both desktop apps write into the same shared `CodeBuddyExtension` auth
// directory and differ only by file basename, environment variable, macOS
// bundle id and Windows executable name. Their models, accounts and credits
// are never mixed: the variant selects which sign-in this tool reads.

/** @typedef {'cn'|'ai'} VariantId */

export const VARIANTS = Object.freeze({
  cn: Object.freeze({
    id: 'cn',
    region: 'cn',
    appName: 'WorkBuddy',
    displayName: 'WorkBuddy',
    desktopFilename: 'workbuddy-desktop.info',
    authEnv: 'WORKBUDDY_AUTH_FILE',
    electronEnv: 'WORKBUDDY_ELECTRON_BIN',
    ownFilename: 'workbuddy-auth.json',
    catalogFilename: 'workbuddy-catalog.json',
    windows: Object.freeze({
      exeBasename: 'workbuddy.exe',
      displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      defaultPathSegments: Object.freeze(['Programs', 'WorkBuddy', 'WorkBuddy.exe']),
    }),
    macOS: Object.freeze({
      bundleId: 'com.tencent.workbuddy.mac',
      defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
    }),
  }),
  ai: Object.freeze({
    id: 'ai',
    region: 'global',
    appName: 'WorkBuddy AI',
    displayName: 'WorkBuddy AI',
    desktopFilename: 'workbuddy-desktop-ai.info',
    authEnv: 'WORKBUDDY_AI_AUTH_FILE',
    electronEnv: 'WORKBUDDY_AI_ELECTRON_BIN',
    ownFilename: 'workbuddy-ai-auth.json',
    catalogFilename: 'workbuddy-ai-catalog.json',
    windows: Object.freeze({
      exeBasename: 'workbuddyai.exe',
      displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
      // The international build has no observed default install path; discovery
      // goes through the Windows uninstall registry only.
      defaultPathSegments: undefined,
    }),
    macOS: Object.freeze({
      bundleId: 'com.workbuddy.workbuddy-ai',
      defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
    }),
  }),
});

export const DEFAULT_VARIANT_ID = 'cn';

/** Look up a variant, or throw a plain usage error. */
export function variantFor(id) {
  const key = String(id ?? DEFAULT_VARIANT_ID).trim().toLowerCase();
  const variant = VARIANTS[key];
  if (variant === undefined) {
    throw new Error(`unknown variant ${JSON.stringify(id)}; expected one of: ${Object.keys(VARIANTS).join(', ')}`);
  }
  return variant;
}
