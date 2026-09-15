/**
 * dsh-feishu-auth — Feishu (Lark) web-app login for the DSH web GUI.
 *
 * The plugin claims one interception point in front of the harness web
 * server's dispatch, then serves its own OAuth endpoints and requires a signed
 * session cookie for everything else. It answers on every address the server
 * is bound to, because the decision never depends on the Host header.
 *
 * Two safety properties are deliberate:
 *  - Fail closed. Missing credentials do not stop the plugin from loading (a
 *    plugin that fails to load would leave the GUI wide open); they put the
 *    gate into a mode where every request is refused with the reason.
 *  - Fail loudly. After mounting, the gate probes its own listening socket in
 *    both directions. A gate that is not actually intercepting is reported as
 *    an error, not assumed.
 *
 * Zero runtime dependencies: node builtins only, so the package resolves in a
 * profile that never installed it through pnpm.
 * @module @jianghuifr/dsh-feishu-auth
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, SESSION_COOKIE, analyzeConfig } from './config.js';
import { createGate } from './gate.js';
import { loadOrCreateSecret, signPayload } from './session.js';

/** Stable Cordis plugin name. */
const name = 'feishu-auth';

/** Services required before the gate can mount. */
const inject = ['webServer'];

const PROBE_ATTEMPTS = 40;
const PROBE_DELAY_MS = 250;
const BLOCKED_STATUSES = new Set([302, 401, 403, 503]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Resolve the harness home the same way the CLI does. */
function resolveHarnessHome() {
  const fromEnvironment = process.env.DSH_HOME;
  if (typeof fromEnvironment === 'string' && fromEnvironment !== '') return fromEnvironment;
  return join(homedir(), '.dsh');
}

/**
 * Build the gate's logger.
 *
 * `ctx.logger` only feeds the harness's in-memory log buffer — nothing it
 * receives is printed by the CLI — so every gate message is mirrored to stderr
 * as well. An operator must be able to see "the gate is mounted", "the gate is
 * refusing everyone", and "this account was denied" in the terminal that runs
 * `dsh web`.
 */
function createOperatorLogger(ctx) {
  const mirror = (level, message) => {
    const text = String(message).replaceAll('\n', '\n    ');
    try {
      process.stderr.write(`${new Date().toISOString()} feishu-auth[${level}] ${text}\n`);
    } catch {
      // A closed stderr must never break the gate.
    }
  };
  return {
    info: (message) => {
      ctx?.logger?.info?.(message);
      mirror('info', message);
    },
    warn: (message) => {
      ctx?.logger?.warn?.(message);
      mirror('warn', message);
    },
    error: (message) => {
      ctx?.logger?.error?.(message);
      mirror('error', message);
    },
  };
}

/**
 * Probe the gate through its own listening socket, in both directions: the
 * unauthenticated request must be refused, and a request carrying a session
 * this process just signed must reach the harness. Anything else means the
 * interception is not in effect.
 */
async function verifyGate({ server, secret, logger }) {
  const port = server?.port;
  if (!Number.isInteger(port) || port <= 0) return;
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : (server.host ?? '127.0.0.1');
  const probeUrl = `http://${host}:${String(port)}/_dsh_feishu_auth_probe_`;
  const probeHeaders = { accept: '*/*', 'x-dsh-feishu-probe': '1' };
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      const anonymous = await fetch(probeUrl, { headers: probeHeaders, redirect: 'manual' });
      if (BLOCKED_STATUSES.has(anonymous.status) !== true) {
        logger.error(
          `自检失败：未登录请求返回 HTTP ${String(anonymous.status)}，网关没有生效。请检查插件行是否启用，并确认没有其它插件覆盖 webServer.match。`,
        );
        return;
      }
      const sessionValue = signPayload(secret, {
        kind: 'session',
        sub: 'self-check',
        name: 'self-check',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const authenticated = await fetch(probeUrl, {
        headers: { ...probeHeaders, cookie: `${SESSION_COOKIE}=${sessionValue}` },
        redirect: 'manual',
      });
      if (BLOCKED_STATUSES.has(authenticated.status)) {
        logger.error(`自检失败：持有效会话的请求仍被拒绝 (HTTP ${String(authenticated.status)})，登录后将无法访问页面。`);
        return;
      }
      logger.info(
        `网关自检通过（未登录 → HTTP ${String(anonymous.status)}，已登录 → HTTP ${String(authenticated.status)}）`,
      );
      return;
    } catch {
      // The socket is not accepting yet; the server binds during its own init.
    }
    await delay(PROBE_DELAY_MS);
  }
  logger.warn('自检未完成：服务器在预期时间内没有开始监听，无法确认网关状态。');
}

/**
 * Mount the Feishu login gate.
 * @param ctx - plugin context carrying the webServer service.
 * @param rawConfig - the config object from this plugin's patch row.
 */
async function apply(ctx, rawConfig = {}) {
  const { config, fatal } = analyzeConfig(rawConfig);
  const logger = createOperatorLogger(ctx);

  const fatalProblems = [...fatal];
  const secretFile = join(resolveHarnessHome(), 'feishu-auth', 'session-secret');
  let secret;
  try {
    secret = loadOrCreateSecret(secretFile);
  } catch (error) {
    fatalProblems.push(`无法读写会话密钥 ${secretFile}：${error?.message ?? String(error)}`);
    secret = randomBytes(32);
  }

  /** Set while the `connection` injection is live; read per request by the gate. */
  let entryUrlProvider;

  /**
   * The harness entry URL carrying this process's launch token.
   *
   * `connection` is reachable only through `ctx.inject`: the scoped callback's
   * context carries the injected service, while `ctx.get('connection')` and
   * `ctx.connection` both fail here. Losing this resolver is not fatal to
   * mounting, so it must fail loud rather than silently degrade every login.
   */
  ctx.inject(['connection'], (connectionCtx) => {
    const { connection } = connectionCtx;
    if (typeof connection?.authenticatedUrl !== 'function') {
      logger.error('connection 服务没有 authenticatedUrl()，无法把浏览器交给 harness 的令牌兑换流程。');
      return;
    }
    connectionCtx.effect(() => {
      entryUrlProvider = (baseUrl) => connection.authenticatedUrl(baseUrl);
      return () => {
        entryUrlProvider = undefined;
      };
    }, 'feishu-auth: harness entry resolver');
  });

  const gate = createGate({
    config,
    secret,
    fatalProblems,
    logger,
    entryUrl: (baseUrl) => entryUrlProvider?.(baseUrl),
  });
  ctx.effect(() => gate.install(ctx.webServer), 'feishu-auth: http gate');

  if (fatalProblems.length > 0) {
    logger.error(`网关已进入故障关闭模式，所有页面访问都会被拒绝：\n  - ${fatalProblems.join('\n  - ')}`);
  } else {
    logger.info(
      `飞书登录已挂载  prefix=${gate.prefix}  允许范围=${
        config.allowedUsers.length > 0 ? `${String(config.allowedUsers.length)} 个账号` : '本应用可用范围内的任意成员'
      }  会话有效期=${String(config.sessionMaxAgeDays)} 天`,
    );
  }

  void verifyGate({ server: ctx.webServer, secret, logger });
}

export { Config, apply, inject, name };
