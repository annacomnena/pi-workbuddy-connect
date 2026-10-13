// Request headers, built from observed protocol facts (docs/protocol.md).
//
// Identity headers travel only to the three upstream hosts. Billing requests
// carry the authorization and identity headers but no client User-Agent;
// catalog requests identify the client by User-Agent because the gateway
// splits its answer on it.
//
// User-Agent policy (risk R3): the version token is taken from the locally
// installed app. This tool never invents a version and never chases "latest".

import { originFor } from './domains.js';

/** CLI-shaped identity used for the CN catalog and token refresh. */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

const APP_VERSION_PATTERN = /^\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** Whether a version string is usable in a User-Agent. */
export function validAppVersion(version) {
  return typeof version === 'string' && APP_VERSION_PATTERN.test(version);
}

/**
 * The App-shaped User-Agent for the global catalog: `WorkBuddyAI/<version>`
 * with no space (the space form is rejected upstream).
 */
export function appUserAgent(version) {
  if (!validAppVersion(version)) throw new Error('invalid WorkBuddy AI version for User-Agent');
  return `WorkBuddyAI/${version}`;
}

/**
 * The desktop-shaped User-Agent for chat/probe: `WorkBuddy/<v> <product>/<v>`
 * with an optional `CLI/<v>` token. A missing CLI version drops the token
 * rather than inventing one.
 */
export function desktopUserAgent({ product, appVersion, cliVersion }) {
  const version = validAppVersion(appVersion) ? appVersion : undefined;
  if (version === undefined) throw new Error('invalid WorkBuddy version for User-Agent');
  const productToken = product === 'WorkBuddy AI' ? 'WorkBuddy AI' : 'WorkBuddy';
  const tokens = [`WorkBuddy/${version}`, `${productToken}/${version}`];
  if (validAppVersion(cliVersion)) tokens.push(`CLI/${cliVersion}`);
  return tokens.join(' ');
}

/** Headers every upstream request shares. */
export function commonHeaders(credential) {
  const origin = originFor(credential);
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

/** Chat/probe headers, including the X-No-* conventions. */
export function chatHeaders(credential, { userAgent, clientVersion }) {
  const headers = {
    ...commonHeaders(credential),
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-Product': 'SaaS',
  };
  if (clientVersion !== undefined && clientVersion !== '') headers['X-IDE-Version'] = clientVersion;
  headers[credential.uid === '' ? 'X-No-User-Id' : 'X-User-Id'] = credential.uid === '' ? '1' : credential.uid;
  headers[credential.enterpriseId === undefined || credential.enterpriseId === ''
    ? 'X-No-Enterprise-Id'
    : 'X-Enterprise-Id'] = credential.enterpriseId === undefined || credential.enterpriseId === ''
    ? '1'
    : credential.enterpriseId;
  headers[credential.domain === '' ? 'X-No-Department-Info' : 'X-Domain'] = credential.domain === '' ? '1' : credential.domain;
  return headers;
}

/** Refresh-endpoint headers. The refresh token appears on this endpoint only. */
export function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
  }
  return headers;
}

/** Billing headers: authorization + identity, never a client User-Agent. */
export function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain;
  return headers;
}

/** Catalog headers. `userAgent` is required; CN uses the CLI shape. */
export function catalogHeaders(credential, { userAgent = CLIENT_UA, product = false } = {}) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    Origin: originFor(credential),
    Referer: `${originFor(credential)}/`,
    'User-Agent': userAgent,
  };
  if (product) {
    headers['X-Requested-With'] = 'XMLHttpRequest';
    headers['X-Product'] = 'SaaS';
  }
  return headers;
}
