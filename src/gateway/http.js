// Loopback HTTP helpers and the four inbound gates.
//
// A loopback bind is not a trust boundary: any local process, and any web page
// that re-resolves its own domain to 127.0.0.1 (DNS rebinding), can reach
// 127.0.0.1. So every request is checked before it is routed:
//
//   1. the Host header must name the loopback interface;
//   2. a browser Origin, when present, must be loopback;
//   3. the Authorization bearer must equal this process's secret
//      (`/healthz` is exempt by design: it carries no credential material);
//   4. a non-GET request must declare `Content-Type: application/json`.
//
// Gate failures have distinct statuses: 403 for "not a loopback caller",
// 401 for "no/wrong bearer", 415 for "wrong media type".

/** Loopback hostnames a local surface may be addressed by. */
export const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', 'localhost', '[::1]']));

/** The request body cap; image payloads are large but bounded. */
export const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;

/** Strip the optional `:port` from a Host header, IPv6-bracket aware. */
export function hostnameOfHost(host) {
  let hostname = String(host ?? '').trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/u.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon);
  }
  return hostname;
}

/** Gate 1: the Host header must name the loopback interface. */
export function hostIsLoopback(host) {
  if (host === undefined || String(host).trim() === '') return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

/** Gate 2: a present Origin must be a loopback origin. */
export function originIsLoopback(origin) {
  if (origin === undefined || String(origin).trim() === '') return true;
  try {
    const { hostname } = new URL(String(origin));
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1';
  } catch {
    return false;
  }
}

/** Gate 4: a non-GET request must be JSON. */
export function isJsonContentType(req) {
  const type = req.headers['content-type'];
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json');
}

/** Write a JSON response. */
export function writeJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Write an OpenAI-shaped error.
 * @returns {object} the body that was written
 */
export function writeOpenAiError(res, status, type, message, headers = {}, extra = {}) {
  const body = { error: { message, type, code: type, ...extra } };
  writeJson(res, status, body, headers);
  return body;
}

/** Read a request body under a size cap; over-limit bodies fail closed. */
export function readBody(req, limit = REQUEST_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('request body too large'), { code: 'body-too-large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => fail(error));
  });
}
