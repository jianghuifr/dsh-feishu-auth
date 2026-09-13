/**
 * Signed-cookie sessions for the Feishu gate.
 *
 * One HMAC-SHA256 secret signs two kinds of payload: the short-lived OAuth
 * `state` cookie that survives the round trip through Feishu, and the browser
 * session cookie minted after a successful login. Both are self-contained
 * (no server-side session store), tamper-evident, and bounded by `exp`.
 * @module dsh-feishu-auth/session
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Cookie payload version prefix; a future format bumps it instead of guessing. */
export const COOKIE_VERSION = 'v1';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Encode bytes as unpadded base64url, the only alphabet safe in a cookie value.
 * @param value - bytes or a string to encode.
 * @returns the unpadded base64url text.
 */
export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Decode unpadded base64url text, rejecting anything that is not canonical
 * (so two different strings can never decode to the same bytes).
 * @param value - the base64url text.
 * @returns the decoded bytes, or undefined when the input is not canonical.
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  return encodeBase64Url(decoded) === value ? decoded : undefined;
}

/**
 * Generate a fresh random token in cookie-safe form.
 * @param bytes - entropy size; 32 bytes for secrets, 24 for one-shot nonces.
 * @returns the encoded token.
 */
export function generateToken(bytes = 32) {
  return encodeBase64Url(randomBytes(bytes));
}

function signature(secret, body) {
  return createHmac('sha256', secret).update(body).digest();
}

/**
 * Serialize a payload into `v1.<body>.<signature>`.
 * @param secret - the signing secret bytes.
 * @param payload - any JSON-serializable payload.
 * @returns the signed cookie value.
 */
export function signPayload(secret, payload) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${COOKIE_VERSION}.${body}.${encodeBase64Url(signature(secret, body))}`;
}

/**
 * Verify and decode a signed value. Any structural damage, signature mismatch,
 * or non-object JSON is a plain rejection: the caller decides what to do.
 * @param secret - the signing secret bytes.
 * @param value - the cookie value to verify.
 * @returns the decoded payload, or undefined when it is not authentic.
 */
export function verifyPayload(secret, value) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const [version, body, provided] = parts;
  if (version !== COOKIE_VERSION || body === undefined || provided === undefined) return undefined;
  const providedBytes = decodeBase64Url(provided);
  if (providedBytes === undefined) return undefined;
  const expectedBytes = signature(secret, body);
  if (providedBytes.byteLength !== expectedBytes.byteLength) return undefined;
  if (!timingSafeEqual(providedBytes, expectedBytes)) return undefined;
  const decoded = decodeBase64Url(body);
  if (decoded === undefined) return undefined;
  try {
    const payload = JSON.parse(decoded.toString('utf8'));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time string comparison for OAuth state nonces.
 * @param actual - value received in the callback query.
 * @param expected - value recorded in the state cookie.
 * @returns true only when both are identical.
 */
export function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Parse a Cookie header into a name to value map. Generated cookie names and
 * values are cookie-safe base64url, so a simple split is enough and no general
 * cookie grammar is reimplemented here.
 * @param headerValue - the raw `Cookie` header.
 * @returns a map of the cookies that were present.
 */
export function parseCookies(headerValue) {
  const cookies = new Map();
  if (typeof headerValue !== 'string') return cookies;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    const name = segment.slice(0, at).trim();
    if (name === '') continue;
    cookies.set(name, segment.slice(at + 1).trim());
  }
  return cookies;
}

/**
 * List the cookie names present on a request. Used to expire the harness's own
 * signed browser cookie on logout without knowing how it derives that name.
 * @param headerValue - the raw `Cookie` header.
 * @returns the cookie names, in header order.
 */
export function cookieNames(headerValue) {
  return [...parseCookies(headerValue).keys()];
}

/**
 * Read one cookie out of the parsed map.
 * @param headerValue - the raw `Cookie` header.
 * @param name - the cookie name.
 * @returns the value, or undefined when absent.
 */
export function readCookie(headerValue, name) {
  return parseCookies(headerValue).get(name);
}

/**
 * Serialize a `Set-Cookie` value for a session/state cookie.
 *
 * `SameSite=Lax` is required, not cosmetic: the OAuth callback arrives as a
 * cross-site top-level GET navigation, which Lax still sends while Strict
 * would not. `Secure` follows the scheme the cookie was minted on so a
 * plain-HTTP LAN address keeps working.
 * @param name - cookie name.
 * @param value - cookie value.
 * @param options - lifetime, Secure flag, and SameSite policy.
 * @returns the header value.
 */
export function serializeCookie(name, value, { maxAgeSeconds, secure = false, sameSite = 'Lax', httpOnly = true } = {}) {
  const parts = [`${name}=${value}`, 'Path=/'];
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);
  return parts.join('; ');
}

/**
 * Serialize the deletion form of a cookie.
 * @param name - cookie name.
 * @param options - `secure` must match how the cookie was set.
 * @returns the header value that expires the cookie.
 */
export function expiredCookie(name, { secure = false } = {}) {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure });
}

/**
 * Load the gate's signing secret from `file`, creating it once with owner-only
 * permissions. A stable secret is what lets a login survive a harness restart.
 * @param file - absolute path of the secret file.
 * @returns the secret bytes.
 */
export function loadOrCreateSecret(file) {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    const decoded = decodeBase64Url(existing);
    if (decoded !== undefined && decoded.byteLength >= 16) return decoded;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid.toString()}.tmp`;
  writeFileSync(temporary, `${encodeBase64Url(secret)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // A filesystem without POSIX modes still has the secret safely written.
  }
  return secret;
}
