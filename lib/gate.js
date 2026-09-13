/**
 * The gate: one interception point in front of every HTTP request the harness
 * web server would otherwise answer.
 *
 * The harness dispatches through `this.match(pathname)` and then hands the
 * request to the matched route's handler, or to the fallback seat when nothing
 * matched. Replacing that single method on the live service instance puts this
 * plugin in front of named routes (`/api`, plugin bundles) AND the SPA
 * fallback at once, on every address the server is bound to.
 *
 * `install()` therefore depends on one internal detail of
 * `@deepseek-ai/dsh-host-webserver` (the dispatch read of `match`). It is
 * checked at install time and reported loudly when absent. The WebSocket
 * upgrade path is left alone: the harness's own mux already enforces its Host
 * fence plus its signed browser cookie, which only browsers that came through
 * this gate ever receive.
 * @module dsh-feishu-auth/gate
 */

import {
  HANDOFF_COOKIE,
  HANDOFF_TTL_SECONDS,
  PATH_PREFIX,
  SESSION_COOKIE,
  STATE_COOKIE,
  STATE_TTL_MS,
} from './config.js';
import { buildAuthorizeUrl, exchangeCode, fetchUserInfo } from './feishu.js';
import { renderDenied, renderError, renderLoggedOut, renderMisconfigured } from './pages.js';
import { cookieNames, expiredCookie, generateToken, readCookie, safeEqual, serializeCookie, signPayload, verifyPayload } from './session.js';
import { clientAddress, isNavigationRequest, normalizeAuthority, requestBaseUrl, sanitizeNext } from './urls.js';

const LOGIN_PATH = '/login';
const CALLBACK_PATH = '/callback';
const LOGOUT_PATH = '/logout';
const STATUS_PATH = '/status';

/**
 * Global symbol Cordis puts on a traceable proxy to expose the wrapped target, so
 * the raw service instance can key per-server state without importing Cordis.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
/** Marker key on an installed dispatcher: `{ gateMatch, original }`. */
export const DISPATCHER = Symbol.for('dsh-feishu-auth.dispatcher');
/** The dispatcher this module currently has installed, per raw web server. */
const installedByServer = new WeakMap();

function send(res, status, body, contentType) {
  const text = String(body);
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendText(res, status, body, headers = {}) {
  send(res, status, `${body}\n`, 'text/plain');
  void headers;
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(html);
}

function redirect(res, status, location, headers = {}) {
  res.writeHead(status, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers });
  res.end();
}

/**
 * Create the gate.
 * @param options - resolved config, session secret, fatal config problems, the
 * harness entry resolver, transport seams, and the logger.
 * @returns the gate: `{ install, mode, prefix }`.
 */
export function createGate({ config, secret, fatalProblems = [], entryUrl, fetchImpl = globalThis.fetch, now = Date.now, logger }) {
  const prefix = PATH_PREFIX;
  const mode = fatalProblems.length > 0 ? 'misconfigured' : 'enforce';
  const maxAgeMilliseconds = config.sessionMaxAgeDays * 24 * 60 * 60 * 1000;
  const log = {
    info: (message) => logger?.info?.(message),
    warn: (message) => logger?.warn?.(message),
    error: (message) => logger?.error?.(message),
  };

  const isSecure = (baseUrl) => typeof baseUrl === 'string' && baseUrl.startsWith('https://');
  const isOwnPath = (pathname) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  /**
   * Decide whether a finished Feishu login may open the page.
   *
   * Feishu already answered the harder question — only a member inside the
   * app's 可用范围 can complete the authorization at all. An empty
   * `allowedUsers` therefore admits any such member; a non-empty one narrows
   * further to the listed open_id / union_id / user_id values.
   */
  function decideAccess(user) {
    if (config.allowedUsers.length === 0) return { allowed: true };
    const identities = [user.open_id, user.union_id, user.user_id].filter((value) => typeof value === 'string');
    return identities.some((value) => config.allowedUsers.includes(value))
      ? { allowed: true }
      : { allowed: false, reason: '该账号不在 allowedUsers 名单中' };
  }

  /** Resolve the caller's principal from the signed session cookie. */
  function authenticate(req) {
    const raw = readCookie(req?.headers?.cookie, SESSION_COOKIE);
    const payload = verifyPayload(secret, raw);
    if (payload === undefined || payload.kind !== 'session') {
      return { ok: false, reason: raw === undefined ? 'no-cookie' : 'invalid-cookie' };
    }
    const nowMs = now();
    if (typeof payload.exp !== 'number' || payload.exp <= nowMs) return { ok: false, reason: 'expired' };
    if (typeof payload.iat === 'number' && payload.iat > nowMs + 60000) return { ok: false, reason: 'not-yet-valid' };
    return { ok: true, user: payload };
  }

  /** Set once when the entry resolver is missing, so the failure is loud but not per-request spam. */
  let warnedMissingEntry = false;

  /**
   * Where to send a just-authenticated browser.
   *
   * A Feishu session alone does not satisfy the harness: it mints its
   * `dsh-auth-<authority>` cookie only for a root request carrying its
   * per-process launch token. So the gate hands the browser to that exchange
   * (`connection.authenticatedUrl`) and the harness redirects on to `/`.
   * Without a resolver this degrades to the requested path, and the harness's
   * own 401 page explains the remedy.
   */
  function entryLocation(req, next) {
    const baseUrl = requestBaseUrl(req);
    if (baseUrl !== undefined && typeof entryUrl === 'function') {
      try {
        const href = entryUrl(`${baseUrl}/`);
        if (typeof href === 'string' && href !== '') {
          const parsed = new URL(href);
          return `${parsed.pathname}${parsed.search}`;
        }
      } catch (error) {
        log.warn(`无法生成 harness 入口地址，回退到 ${next} (${error?.message ?? String(error)})`);
      }
    } else if (warnedMissingEntry !== true) {
      warnedMissingEntry = true;
      log.error('拿不到 harness 的入口地址（connection 服务不可达）：登录后浏览器会被直接送到 harness 的 401 页面。');
    }
    return next;
  }

  /**
   * Whether an authenticated navigation must first pass through the harness's
   * launch-token exchange: a browser holding a valid Feishu session but no
   * `dsh-auth-*` cookie (fresh device, cleared cookies, harness restart) would
   * otherwise land on the harness's 401 page with no way forward.
   *
   * The `token` guard keeps the exchange request itself from looping, and the
   * handoff marker bounds the attempt when a browser refuses to store the
   * harness cookie — without it, such a browser would bounce between `/` and
   * `/?token=…` forever.
   */
  function needsHarnessHandoff(req, url) {
    if (url.pathname !== '/') return false;
    if (url.searchParams.has('token')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (isNavigationRequest(req) !== true) return false;
    const names = cookieNames(req?.headers?.cookie);
    if (names.includes(HANDOFF_COOKIE)) return false;
    return names.some((name) => name.startsWith('dsh-auth-')) !== true;
  }

  /** Deliver the request to the harness exactly as it would have been delivered. */
  async function passthrough(req, res, route, server) {
    const target = typeof route?.handler === 'function' ? route.handler : server.fallback;
    if (typeof target !== 'function') {
      res.writeHead(404);
      res.end();
      return;
    }
    await target(req, res);
  }

  /** Refuse an unauthenticated request: redirect browsers, 401 everything else. */
  function deny(req, res, url, principal) {
    if (mode === 'misconfigured') {
      sendHtml(res, 503, renderMisconfigured({ problem: fatalProblems.join('；') }));
      return;
    }
    if (req?.headers?.['x-dsh-feishu-probe'] !== '1') {
      log.warn(
        `拒绝未认证请求 ${String(req?.method ?? 'GET')} ${url.pathname} host=${normalizeAuthority(req?.headers?.host) ?? 'no-host'} from ${clientAddress(req)} (${principal.reason})`,
      );
    }
    if (isNavigationRequest(req)) {
      redirect(res, 302, `${prefix}${LOGIN_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
      return;
    }
    send(
      res,
      401,
      `${JSON.stringify({ error: 'feishu_auth_required', message: '需要先通过飞书登录才能访问这台 DSH。', login: `${prefix}${LOGIN_PATH}` }, null, 2)}\n`,
      'application/json',
    );
  }

  /** Start the OAuth flow: mint a state cookie and send the browser to Feishu. */
  function handleLogin(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (mode === 'misconfigured') {
      sendHtml(res, 503, renderMisconfigured({ problem: fatalProblems.join('；') }));
      return;
    }
    const next = sanitizeNext(url.searchParams.get('next'));
    if (authenticate(req).ok === true) {
      redirect(res, 303, entryLocation(req, next));
      return;
    }
    const baseUrl = requestBaseUrl(req);
    if (baseUrl === undefined) {
      sendHtml(
        res,
        400,
        renderError({
          heading: '请求缺少可用的 Host',
          message: '无法从该请求推导回调地址，请检查反向代理是否传递了 Host 头。',
          loginPath: `${prefix}${LOGIN_PATH}`,
        }),
      );
      return;
    }
    const redirectUri = `${baseUrl}${prefix}${CALLBACK_PATH}`;
    const nonce = generateToken(24);
    const issuedAt = now();
    const stateValue = signPayload(secret, {
      kind: 'state',
      nonce,
      next,
      redirectUri,
      iat: issuedAt,
      exp: issuedAt + STATE_TTL_MS,
    });
    redirect(res, 302, buildAuthorizeUrl({ clientId: config.appId, redirectUri, state: nonce }), {
      'set-cookie': serializeCookie(STATE_COOKIE, stateValue, { maxAgeSeconds: STATE_TTL_MS / 1000, secure: isSecure(baseUrl) }),
    });
  }

  /** Finish the OAuth flow: verify state, read the profile, mint the session. */
  async function handleCallback(req, res, url) {
    if (req.method !== 'GET') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    if (mode === 'misconfigured') {
      sendHtml(res, 503, renderMisconfigured({ problem: fatalProblems.join('；') }));
      return;
    }
    const baseUrl = requestBaseUrl(req);
    const secure = isSecure(baseUrl);
    const clearState = expiredCookie(STATE_COOKIE, { secure });
    const failure = (heading, message, detail) => {
      sendHtml(res, 403, renderError({ heading, message, detail, loginPath: `${prefix}${LOGIN_PATH}` }), {
        'set-cookie': clearState,
      });
    };

    const stateCookie = verifyPayload(secret, readCookie(req?.headers?.cookie, STATE_COOKIE));
    if (stateCookie === undefined || stateCookie.kind !== 'state') {
      failure('登录会话已失效', '没有找到有效的登录状态，请重新发起登录。');
      return;
    }
    if (typeof stateCookie.exp !== 'number' || stateCookie.exp <= now()) {
      failure('登录超时', '这次登录停留得太久（超过 10 分钟），请重新发起。');
      return;
    }
    const deniedByUser = url.searchParams.get('error');
    if (deniedByUser !== null) {
      failure('授权未完成', `飞书没有完成授权 (${deniedByUser})。`);
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (typeof code !== 'string' || code === '' || typeof state !== 'string' || state === '') {
      failure('回调参数不完整', '飞书回调缺少 code 或 state 参数，请重新发起登录。');
      return;
    }
    if (safeEqual(state, stateCookie.nonce) !== true) {
      failure('state 校验失败', '回调的 state 与本次登录不匹配，出于安全考虑已中止。');
      return;
    }

    const address = clientAddress(req);
    let user;
    try {
      const token = await exchangeCode({
        clientId: config.appId,
        clientSecret: config.appSecret,
        code,
        redirectUri:
          typeof stateCookie.redirectUri === 'string' ? stateCookie.redirectUri : `${baseUrl ?? ''}${prefix}${CALLBACK_PATH}`,
        fetchImpl,
      });
      user = await fetchUserInfo({ accessToken: token.accessToken, fetchImpl });
    } catch (error) {
      const detail = error?.message ?? String(error);
      log.error(`登录失败 from ${address} :: ${detail}`);
      failure('飞书登录失败', '无法用这次授权换取用户身份，请重试；若持续失败请查看 dsh web 终端日志。', detail);
      return;
    }

    const label = user.name ?? user.open_id;
    const decision = decideAccess(user);
    if (decision.allowed !== true) {
      log.warn(`拒绝登录 name=${label} open_id=${user.open_id} :: ${decision.reason}`);
      sendHtml(
        res,
        403,
        renderDenied({ name: user.name, openId: user.open_id, reason: decision.reason, loginPath: `${prefix}${LOGIN_PATH}` }),
        { 'set-cookie': clearState },
      );
      return;
    }

    const issuedAt = now();
    const expiresAt = issuedAt + maxAgeMilliseconds;
    const sessionValue = signPayload(secret, {
      kind: 'session',
      sub: user.open_id,
      name: label,
      tenant: user.tenant_key,
      iat: issuedAt,
      exp: expiresAt,
    });
    log.info(`登录成功 name=${label} open_id=${user.open_id} tenant=${user.tenant_key ?? '?'} from ${address}`);
    redirect(res, 303, entryLocation(req, sanitizeNext(typeof stateCookie.next === 'string' ? stateCookie.next : '/')), {
      'set-cookie': [
        serializeCookie(SESSION_COOKIE, sessionValue, { maxAgeSeconds: maxAgeMilliseconds / 1000, secure }),
        clearState,
      ],
    });
  }

  /** Clear this gate's cookies and the harness's own browser cookie. */
  function handleLogout(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendText(res, 405, 'method not allowed');
      return;
    }
    const secure = isSecure(requestBaseUrl(req));
    const cookies = [expiredCookie(SESSION_COOKIE, { secure }), expiredCookie(HANDOFF_COOKIE, { secure })];
    // Expiring by name needs no knowledge of how the harness derives it.
    for (const name of cookieNames(req?.headers?.cookie)) {
      if (name.startsWith('dsh-auth-')) cookies.push(expiredCookie(name, { secure }));
    }
    sendHtml(res, 200, renderLoggedOut({ loginPath: `${prefix}${LOGIN_PATH}` }), { 'set-cookie': cookies });
  }

  /** Report the caller's own gate state — the operator's diagnostic endpoint. */
  function handleStatus(req, res) {
    const principal = authenticate(req);
    const payload = {
      gate: mode,
      authenticated: principal.ok === true,
      reason: principal.ok === true ? undefined : principal.reason,
      problems: fatalProblems.length > 0 ? fatalProblems : undefined,
    };
    if (principal.ok === true) {
      payload.user = { name: principal.user.name, openId: principal.user.sub, tenantKey: principal.user.tenant };
      payload.expiresAt = new Date(principal.user.exp).toISOString();
    }
    send(res, 200, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
  }

  async function handleOwnPath(req, res, url) {
    if (url.pathname === `${prefix}${LOGIN_PATH}`) return handleLogin(req, res, url);
    if (url.pathname === `${prefix}${CALLBACK_PATH}`) return handleCallback(req, res, url);
    if (url.pathname === `${prefix}${LOGOUT_PATH}`) return handleLogout(req, res);
    if (url.pathname === `${prefix}${STATUS_PATH}`) return handleStatus(req, res);
    if (url.pathname === prefix || url.pathname === `${prefix}/`) {
      redirect(res, 302, `${prefix}${LOGIN_PATH}`);
      return;
    }
    sendText(res, 404, 'not found');
  }

  /** Decide one request, then either pass it through or refuse it. */
  async function dispatch(req, res, route, server) {
    let url;
    try {
      url = new URL(req?.url ?? '/', 'http://gate.invalid');
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    if (isOwnPath(url.pathname)) {
      try {
        await handleOwnPath(req, res, url);
      } catch (error) {
        log.error(`处理 ${url.pathname} 时出错 :: ${error?.stack ?? String(error)}`);
        if (res.headersSent !== true) sendText(res, 500, 'internal error');
        else res.destroy();
      }
      return;
    }
    const principal = mode === 'misconfigured' ? { ok: false, reason: 'misconfigured' } : authenticate(req);
    if (principal.ok !== true) {
      deny(req, res, url, principal);
      return;
    }
    if (needsHarnessHandoff(req, url)) {
      const requested = `${url.pathname}${url.search}`;
      const target = entryLocation(req, requested);
      // A resolver that is missing or throws degrades to the requested path.
      // Redirecting to it would repeat this exact state forever, so fall
      // through to the harness instead: its own 401 page is terminal.
      if (target !== requested) {
        redirect(res, 303, target, {
          'set-cookie': serializeCookie(HANDOFF_COOKIE, '1', {
            maxAgeSeconds: HANDOFF_TTL_SECONDS,
            secure: isSecure(requestBaseUrl(req)),
          }),
        });
        return;
      }
    }
    await passthrough(req, res, route, server);
  }

  /**
   * Install the interception on a live web server instance.
   *
   * Two hazards make the obvious implementation wrong, and both come from the
   * harness exposing `webServer` as a Cordis service:
   *
   * - A member read returns a **fresh proxy** every time (Cordis wraps
   *   function-valued service members so a call is attributed to its caller),
   *   so `server.match === gateMatch` is never true and an identity-guarded
   *   disposer silently leaves the gate installed forever.
   * - A reload can mount the replacement **before** the previous disposer
   *   runs, so an unconditional restore would tear down the live layer.
   *
   * The layer therefore identifies itself through a symbol-keyed marker on the
   * installed function (readable through any wrapping proxy), records itself
   * per server in {@link installedByServer}, and reuses the original captured
   * by a leftover layer instead of stacking on top of it.
   * @param server - the `webServer` service instance.
   * @returns a disposer that restores the original dispatch.
   * @throws when this harness version exposes no dispatch seam — refusing to
   * run is the point: a silently unmounted gate would leave the page open.
   */
  function install(server) {
    const current = server?.match;
    if (typeof current !== 'function') {
      throw new Error(
        'dsh-feishu-auth: 当前 dsh 版本的 webServer 没有可拦截的 match(pathname) 分发点，登录网关无法挂载；' +
          '为避免页面在无保护状态下暴露，插件拒绝以不安全状态运行。请升级/降级 dsh 到兼容版本，或临时禁用该插件行。',
      );
    }
    // The raw service is the stable key; every `ctx.webServer` read hands out a new proxy.
    const key = server?.[CORDIS_ORIGINAL] ?? server;
    // A layer this module left installed (older dsh versions could not unwrap)
    // already knows the true original: inherit it rather than nesting.
    const leftover = current[DISPATCHER];
    const originalMatch = typeof leftover?.original === 'function' ? leftover.original : current;
    const gateMatch = function gateMatch(pathname) {
      const route = originalMatch.call(server, pathname);
      return { kind: 'exact', path: pathname, handler: (req, res) => dispatch(req, res, route, server) };
    };
    gateMatch[DISPATCHER] = { gateMatch, original: originalMatch };
    server.match = gateMatch;
    installedByServer.set(key, gateMatch);
    return () => {
      // Only the newest layer may unwrap, and only while it is still on top:
      // a reload mounts its replacement first and disposes the old fiber after.
      if (installedByServer.get(key) !== gateMatch) return;
      if (server.match?.[DISPATCHER]?.gateMatch !== gateMatch) return;
      server.match = originalMatch;
      installedByServer.delete(key);
    };
  }

  return { install, mode, prefix };
}
