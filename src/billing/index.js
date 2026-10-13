// Real credit/resource-pack balance.
//
// Reading the balance is the only upstream request S3 makes, and it is a
// read: the account's usage is described, nothing is charged. There is no
// local accounting anywhere in this project — the upstream bills by token, and
// this module only reports what the billing endpoint says.
//
// Two upstream shapes exist, chosen by account type:
//   - CN enterprise (`enterpriseId` non-empty): one cycle quota.
//   - Everyone else: a list of named packages.
// The enterprise endpoint is unverified for the global region, so a global
// credential stays on the personal path even if it carries an enterprise id.

import { REASON, WbError } from '../errors.js';
import { billingBaseFor, regionOfDomain } from '../upstream/domains.js';
import { billingHeaders } from '../upstream/headers.js';

const PERSONAL_PATH = '/v2/billing/meter/get-user-resource';
const ENTERPRISE_URL = 'https://www.codebuddy.cn/v2/billing/meter/get-enterprise-user-usage';
const PRODUCT_CODE = 'p_tcaca';
const PACKAGE_END_RANGE_EXTRA_MS = 3_185_136_000_000;

function formatTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Parse a zone-less `YYYY-MM-DD HH:mm:ss` as the machine's local time. */
export function parseCycleEndTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(date.getTime())) return undefined;
  // Reject values that roll over (2026-02-31 -> March) so a malformed answer
  // is not reported as a real date.
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
  ) return undefined;
  return date.getTime();
}

function numberAt(source, key) {
  return typeof source?.[key] === 'number' ? source[key] : undefined;
}

/** Extract the personal-path packages from an envelope payload. */
function parsePersonalAccounts(envelope) {
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {};
  const response = typeof data.Response === 'object' && data.Response !== null ? data.Response : {};
  const inner = typeof response.Data === 'object' && response.Data !== null ? response.Data : {};
  const rawAccounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
  const packages = [];
  let total = 0;
  for (const raw of rawAccounts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const size = numberAt(raw, 'CycleCapacitySize') ?? 0;
    const cycleRemain = numberAt(raw, 'CycleCapacityRemain') ?? 0;
    const cycleUsed = numberAt(raw, 'CycleCapacityUsed') ?? 0;
    const capacityRemain = numberAt(raw, 'CapacityRemain') ?? 0;
    let remain;
    if (size > 0) remain = cycleRemain;
    else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
    else remain = capacityRemain;
    if (remain < 0) remain = 0;
    total += remain;
    const endTimeMs = parseCycleEndTime(raw.CycleEndTime);
    packages.push({
      name: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
      remain,
      size: size > 0 ? size : (numberAt(raw, 'CapacitySize') ?? 0),
      ...(endTimeMs === undefined ? {} : { endTimeMs }),
    });
  }
  return { total, packages, unlimited: false };
}

/** Extract the enterprise-path single quota from an envelope payload. */
function parseEnterpriseQuota(envelope) {
  const sources = [];
  for (const candidate of [envelope.data, envelope.document]) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    if (typeof candidate.data === 'object' && candidate.data !== null && !Array.isArray(candidate.data)) {
      sources.push(candidate.data);
    }
    sources.push(candidate);
  }
  for (const source of sources) {
    const limit = numberAt(source, 'limitNum') ?? numberAt(source, 'limit_num');
    if (limit === undefined) continue;
    const resetTime = typeof source.cycleResetTime === 'string' && source.cycleResetTime !== ''
      ? source.cycleResetTime
      : undefined;
    if (limit === -1) {
      return {
        total: 0,
        packages: [{ name: 'enterprise', remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }),
      };
    }
    const used = numberAt(source, 'credit') ?? numberAt(source, 'used_num');
    if (used === undefined) {
      throw new WbError(
        REASON.upstreamClientError,
        'the enterprise billing response carried a quota limit but no recognised usage field',
      );
    }
    const remain = Math.max(0, limit - used);
    return {
      total: remain,
      packages: [{ name: 'enterprise', remain, size: limit }],
      unlimited: false,
      ...(resetTime === undefined ? {} : { cycleResetTime: resetTime }),
    };
  }
  throw new WbError(
    REASON.upstreamClientError,
    'the enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num)',
  );
}

function asBillingFailure(error, endpoint) {
  if (error instanceof WbError) {
    if (error.code === REASON.upstreamUnreachable) {
      return new WbError(REASON.billingUnreachable, 'the billing endpoint could not be reached', {
        cause: error,
        detail: { endpoint },
      });
    }
    return error;
  }
  return new WbError(REASON.billingUnreachable, 'the billing request failed', { cause: error, detail: { endpoint } });
}

/**
 * Read the account's real balance.
 * @param {{ client: import('../upstream/client.js').UpstreamClient, credential: object, now?: number }} options
 * @returns {Promise<{ ok: true, total: number, packages: object[], unlimited: boolean,
 *   cycleResetTime?: string, endpoint: string, fetchedAt: number }>}
 */
export async function fetchCredits({ client, credential, now = Date.now() }) {
  const enterprise = regionOfDomain(credential.domain) === 'cn'
    && credential.enterpriseId !== undefined && credential.enterpriseId !== '';
  const endpoint = enterprise ? ENTERPRISE_URL : client.url(billingBaseFor(credential), PERSONAL_PATH).toString();
  try {
    const result = enterprise
      ? await client.send({
        url: endpoint,
        method: 'POST',
        headers: billingHeaders(credential),
        body: JSON.stringify({}),
      })
      : await client.send({
        url: client.url(billingBaseFor(credential), PERSONAL_PATH),
        method: 'POST',
        headers: billingHeaders(credential),
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: PRODUCT_CODE,
          Status: [0, 3],
          PackageEndTimeRangeBegin: formatTimestamp(new Date(now)),
          PackageEndTimeRangeEnd: formatTimestamp(new Date(now + PACKAGE_END_RANGE_EXTRA_MS)),
        }),
      });
    const envelope = client.ensureOk(result, 'the billing read');
    const parsed = enterprise ? parseEnterpriseQuota(envelope) : parsePersonalAccounts(envelope);
    return { ok: true, ...parsed, endpoint, fetchedAt: now };
  } catch (error) {
    throw asBillingFailure(error, endpoint);
  }
}
