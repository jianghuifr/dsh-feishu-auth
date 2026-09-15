/**
 * Feishu (Lark) OAuth 2.0 authorization-code flow, server side.
 *
 * Endpoints are the current open-platform contract for a 网页应用 (web app):
 *  - authorize:  GET  https://accounts.feishu.cn/open-apis/authen/v1/authorize
 *  - token:      POST https://accounts.feishu.cn/oauth/v3/token
 *  - user info:  GET  https://open.feishu.cn/open-apis/authen/v1/user_info
 *
 * The returned user access token is used once, to read the profile, and is
 * never persisted: this plugin's own signed cookie is the session.
 * @module @jianghuifr/dsh-feishu-auth/feishu
 */

const AUTHORIZE_ORIGIN = 'https://accounts.feishu.cn';
const TOKEN_ORIGIN = 'https://accounts.feishu.cn';
const OPEN_API_ORIGIN = 'https://open.feishu.cn';
const TIMEOUT_MS = 10000;

/** A Feishu API failure with the operator-facing detail already extracted. */
export class FeishuApiError extends Error {
  /**
   * @param message - sanitized description (never contains a token or secret).
   * @param status - the HTTP status when the failure had one.
   */
  constructor(message, status) {
    super(message);
    this.name = 'FeishuApiError';
    this.status = status;
  }
}

/**
 * Build the authorization-page URL the browser is redirected to.
 * @param options - app id, redirect URI, and the state nonce.
 * @returns the absolute authorize URL.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL('/open-apis/authen/v1/authorize', AUTHORIZE_ORIGIN);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.href;
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    if (json === null || typeof json !== 'object') throw new Error('not an object');
    return json;
  } catch {
    throw new FeishuApiError(`${label}: 返回了非 JSON 响应 (HTTP ${String(response.status)})`, response.status);
  }
}

/** Unwrap the platform's two response shapes: flat, or nested under `data`. */
function unwrap(json) {
  return json.data !== null && typeof json.data === 'object' ? { ...json, ...json.data } : json;
}

/**
 * Exchange an authorization code for a user access token.
 *
 * The `redirect_uri` must be byte-identical to the one used on the authorize
 * request, which is why the caller replays the value stored in the state
 * cookie rather than recomputing it.
 * @param options - credentials, code, redirect URI, and a transport seam.
 * @returns the user access token.
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl = globalThis.fetch }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  let response;
  try {
    response = await fetchImpl(new URL('/oauth/v3/token', TOKEN_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeishuApiError(`换取 user_access_token 失败: ${error?.message ?? String(error)}`);
  }
  const json = unwrap(await readJson(response, 'token 接口'));
  if (typeof json.access_token !== 'string' || json.access_token === '') {
    const detail = json.error_description ?? json.error ?? json.msg ?? `HTTP ${String(response.status)}`;
    throw new FeishuApiError(`换取 user_access_token 被拒绝: ${String(detail)}`, response.status);
  }
  return { accessToken: json.access_token };
}

/**
 * Read the authenticated user's profile with a user access token.
 * @param options - token and a transport seam.
 * @returns `open_id`, `union_id`, `user_id`, `name`, `tenant_key` (`open_id` and
 * `tenant_key` need no extra permission).
 */
export async function fetchUserInfo({ accessToken, fetchImpl = globalThis.fetch }) {
  let response;
  try {
    response = await fetchImpl(new URL('/open-apis/authen/v1/user_info', OPEN_API_ORIGIN), {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeishuApiError(`读取用户信息失败: ${error?.message ?? String(error)}`);
  }
  const json = unwrap(await readJson(response, 'user_info 接口'));
  if (json.code !== 0 && json.code !== undefined) {
    throw new FeishuApiError(`读取用户信息被拒绝: ${String(json.msg ?? json.code)}`, response.status);
  }
  if (typeof json.open_id !== 'string' || json.open_id === '') {
    throw new FeishuApiError('用户信息缺少 open_id', response.status);
  }
  return {
    open_id: json.open_id,
    union_id: typeof json.union_id === 'string' ? json.union_id : undefined,
    user_id: typeof json.user_id === 'string' ? json.user_id : undefined,
    name: typeof json.name === 'string' ? json.name : undefined,
    tenant_key: typeof json.tenant_key === 'string' ? json.tenant_key : undefined,
  };
}
