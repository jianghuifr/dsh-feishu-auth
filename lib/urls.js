/**
 * Request-derived URLs and the open-redirect guard.
 *
 * Pure functions of request-shaped data, so the security-relevant decisions
 * stay testable without a live server.
 * @module @jianghuifr/dsh-feishu-auth/urls
 */

/**
 * Canonicalize a Host header into a lowercase `host[:port]` authority.
 *
 * Rejects anything carrying userinfo, a path, a query, a fragment, whitespace,
 * or a backslash, so a hostile Host can never become a `Set-Cookie` audience
 * for another origin.
 * @param host - the raw `Host` header value.
 * @returns the canonical authority, or undefined when it is not one.
 */
export function normalizeAuthority(host) {
  if (typeof host !== 'string') return undefined;
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return undefined;
  if (/[\s/\\?#@]/.test(trimmed)) return undefined;
  try {
    const url = new URL(`http://${trimmed}`);
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
    return url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the externally visible origin of this request: scheme plus Host as
 * the request presents them.
 *
 * The OAuth `redirect_uri` is derived from this value, so one deployment
 * serves a LAN IP, loopback, and a tunnel hostname without per-address
 * configuration. A reverse proxy's `X-Forwarded-Proto` is honored because a
 * forged value can only break the caller's own login: it would hand out a
 * `Secure` cookie over plain http, which the browser then refuses.
 * @param req - incoming request.
 * @returns origin without a trailing slash, or undefined for an invalid Host.
 */
export function requestBaseUrl(req) {
  const authority = normalizeAuthority(req?.headers?.host);
  if (authority === undefined) return undefined;
  const forwarded = req?.headers?.['x-forwarded-proto'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim().toLowerCase() : undefined;
  const scheme = first === 'https' || first === 'http' ? first : req?.socket?.encrypted === true ? 'https' : 'http';
  return `${scheme}://${authority}`;
}

/**
 * Sanitize a `next` target into a same-origin absolute path.
 * @param raw - the untrusted `next` query value.
 * @returns an absolute path beginning with exactly one `/`.
 */
export function sanitizeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  // Some clients normalize '\' to '/', which would resurrect a '//' prefix.
  if (raw.includes('\\')) return '/';
  return raw;
}

/**
 * Client address for the audit log: the socket peer, plus the first forwarded
 * hop when a proxy supplied one.
 * @param req - incoming request.
 * @returns a loggable address string.
 */
export function clientAddress(req) {
  const socketAddress = req?.socket?.remoteAddress ?? 'unknown';
  const forwarded = req?.headers?.['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  return first === undefined || first === '' ? socketAddress : `${first} via ${socketAddress}`;
}

/**
 * Whether this request is a browser navigation, which decides between a
 * redirect to the login page and a JSON 401 for programmatic callers.
 * @param req - incoming request.
 * @returns true when the response should be an HTML redirect.
 */
export function isNavigationRequest(req) {
  if (req?.method !== 'GET') return false;
  const accept = req?.headers?.accept;
  if (typeof accept === 'string' && accept.includes('text/html')) return true;
  // Fetch Metadata is authoritative when the browser sends it and there is no
  // Accept header at all.
  return req?.headers?.['sec-fetch-mode'] === 'navigate' && accept === undefined;
}
