import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { HANDOFF_COOKIE, SESSION_COOKIE, STATE_COOKIE, analyzeConfig } from '../lib/config.js';
import { createGate } from '../lib/gate.js';
import { signPayload, verifyPayload } from '../lib/session.js';

const secret = randomBytes(32);
const HOST = '127.0.0.1:3080';
const silent = { info() {}, warn() {}, error() {} };

/** A web-server stand-in with the real dispatch shape: exact, longest prefix, fallback. */
function fakeServer({ routes = [], fallback } = {}) {
  const exact = new Map();
  const prefixes = new Map();
  for (const route of routes) (route.kind === 'prefix' ? prefixes : exact).set(route.path, route);
  return {
    fallback,
    match(pathname) {
      const hit = exact.get(pathname);
      if (hit !== undefined) return hit;
      let best;
      for (const [prefix, route] of prefixes) {
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
        if (best === undefined || prefix.length > best.path.length) best = route;
      }
      return best;
    },
  };
}

function fakeReq({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers: { host: HOST, accept: '*/*', ...headers }, socket: { remoteAddress: '10.0.0.9' } };
}

function fakeRes() {
  return {
    statusCode: undefined,
    headers: undefined,
    headersSent: false,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
    },
    destroy() {},
  };
}

function setCookies(res) {
  const raw = res.headers?.['set-cookie'];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
}

function cookiePair(res, name) {
  const entry = setCookies(res).find((cookie) => cookie.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(0, entry.indexOf(';'));
}

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function configWith(overrides = {}) {
  return analyzeConfig({ appId: 'cli_test', appSecret: 'app-secret', ...overrides }).config;
}

function makeGate({ config = configWith(), fatalProblems = [], entryUrl, fetchImpl, logger = silent } = {}) {
  return createGate({
    config,
    secret,
    fatalProblems,
    logger,
    entryUrl: entryUrl === null ? undefined : (entryUrl ?? ((base) => `${base.replace(/\/$/u, '')}/?token=launch-token`)),
    fetchImpl: fetchImpl ?? (async () => jsonResponse({ code: 0, data: {} })),
  });
}

function sessionCookie(overrides = {}) {
  const now = Date.now();
  return `${SESSION_COOKIE}=${signPayload(secret, { kind: 'session', sub: 'ou_1', name: '张三', iat: now, exp: now + 3600_000, ...overrides })}`;
}

/** Drive the two OAuth legs against the installed gate and return both responses. */
async function completeLogin({ server, headers = {} }) {
  const loginRes = fakeRes();
  await server.match('/feishu-auth/login').handler(fakeReq({ url: '/feishu-auth/login', headers }), loginRes);
  const statePair = cookiePair(loginRes, STATE_COOKIE);
  const nonce = verifyPayload(secret, statePair.split('=')[1]).nonce;
  const callbackRes = fakeRes();
  await server.match('/feishu-auth/callback').handler(
    fakeReq({ url: `/feishu-auth/callback?code=the-code&state=${nonce}`, headers: { ...headers, cookie: statePair } }),
    callbackRes,
  );
  return { loginRes, callbackRes, nonce };
}

const feishuOk = async (url) =>
  String(url).includes('/oauth/v3/token')
    ? jsonResponse({ code: 0, access_token: 'u-token' })
    : jsonResponse({ code: 0, data: { open_id: 'ou_1', name: '张三', tenant_key: 'tk_1' } });

test('install() intercepts the dispatch and dispose() restores it', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(404) });
  const gate = makeGate();
  const original = server.match;
  const dispose = gate.install(server);
  const res = fakeRes();
  await server.match('/dashboard').handler(fakeReq({ url: '/dashboard', headers: { accept: 'text/html' } }), res);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/feishu-auth\/login\?next=/u);
  dispose();
  assert.equal(server.match, original);
});

test('deny: browsers get a redirect, programmatic callers get a JSON 401', async () => {
  let ownerRan = false;
  const server = fakeServer({ routes: [{ kind: 'prefix', path: '/api', handler: () => { ownerRan = true; } }] });
  makeGate().install(server);

  const page = fakeRes();
  await server.match('/deep/link?x=1').handler(fakeReq({ url: '/deep/link?x=1', headers: { accept: 'text/html' } }), page);
  assert.equal(page.statusCode, 302);
  assert.equal(page.headers.location, '/feishu-auth/login?next=%2Fdeep%2Flink%3Fx%3D1');

  const api = fakeRes();
  await server.match('/api/session.list').handler(fakeReq({ url: '/api/session.list', method: 'POST' }), api);
  assert.equal(api.statusCode, 401);
  assert.equal(JSON.parse(api.body).error, 'feishu_auth_required');
  assert.equal(ownerRan, false, 'the gate must decide before the route owner runs');
});

test('a valid session reaches the named route, and an unknown path reaches the fallback', async () => {
  let routed = 0;
  let fellBack = 0;
  const server = fakeServer({
    routes: [{ kind: 'prefix', path: '/api', handler: (req, res) => { routed += 1; res.writeHead(200); } }],
    fallback: (req, res) => { fellBack += 1; res.writeHead(404); },
  });
  makeGate().install(server);

  const api = fakeRes();
  await server.match('/api/x').handler(fakeReq({ url: '/api/x', headers: { cookie: sessionCookie() } }), api);
  assert.equal(api.statusCode, 200);
  const page = fakeRes();
  await server.match('/some/page').handler(fakeReq({ url: '/some/page', headers: { cookie: sessionCookie() } }), page);
  assert.equal(page.statusCode, 404);
  assert.deepEqual([routed, fellBack], [1, 1]);
});

test('an expired, foreign-signed, or malformed session is refused', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(200) });
  makeGate().install(server);
  const cases = [
    sessionCookie({ exp: Date.now() - 1000 }),
    `${SESSION_COOKIE}=${signPayload(randomBytes(32), { kind: 'session', exp: Date.now() + 1000 })}`,
    `${SESSION_COOKIE}=garbage`,
    `${SESSION_COOKIE}=${signPayload(secret, { kind: 'state', exp: Date.now() + 1000 })}`,
  ];
  for (const cookie of cases) {
    const res = fakeRes();
    await server.match('/x').handler(fakeReq({ url: '/x', headers: { cookie } }), res);
    assert.equal(res.statusCode, 401, `expected ${cookie.slice(0, 40)} to be refused`);
  }
});

test('login redirects to Feishu with a signed state cookie', async () => {
  const server = fakeServer({});
  makeGate().install(server);
  const res = fakeRes();
  await server.match('/feishu-auth/login').handler(fakeReq({ url: '/feishu-auth/login?next=/api/x' }), res);
  assert.equal(res.statusCode, 302);
  const target = new URL(res.headers.location);
  assert.equal(target.origin, 'https://accounts.feishu.cn');
  assert.equal(target.searchParams.get('client_id'), 'cli_test');
  assert.equal(target.searchParams.get('redirect_uri'), `http://${HOST}/feishu-auth/callback`);
  const state = verifyPayload(secret, cookiePair(res, STATE_COOKIE).split('=')[1]);
  assert.equal(state.next, '/api/x');
  assert.equal(target.searchParams.get('state'), state.nonce);
});

test('a finished login mints a session and hands the browser to the harness', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(200) });
  makeGate({ fetchImpl: feishuOk }).install(server);
  const { callbackRes } = await completeLogin({ server });

  assert.equal(callbackRes.statusCode, 303);
  assert.equal(callbackRes.headers.location, '/?token=launch-token');
  const sessionPair = cookiePair(callbackRes, SESSION_COOKIE);
  assert.equal(verifyPayload(secret, sessionPair.split('=')[1]).sub, 'ou_1');
  assert.match(setCookies(callbackRes).find((cookie) => cookie.startsWith(STATE_COOKIE)), /Max-Age=0/u);

  const page = fakeRes();
  await server.match('/').handler(fakeReq({ url: '/', headers: { cookie: sessionPair, accept: 'text/html' } }), page);
  assert.equal(page.statusCode, 303, 'without a harness cookie the browser is exchanged first');
  const served = fakeRes();
  await server.match('/').handler(
    fakeReq({ url: '/', headers: { cookie: `${sessionPair}; dsh-auth-x=v1.b.s`, accept: 'text/html' } }),
    served,
  );
  assert.equal(served.statusCode, 200);
});

test('a mismatched state, a revoked authorization, and an upstream failure all refuse the login', async () => {
  const server = fakeServer({});
  makeGate().install(server);
  const loginRes = fakeRes();
  await server.match('/feishu-auth/login').handler(fakeReq({ url: '/feishu-auth/login' }), loginRes);
  const statePair = cookiePair(loginRes, STATE_COOKIE);

  const mismatch = fakeRes();
  await server.match('/feishu-auth/callback').handler(
    fakeReq({ url: '/feishu-auth/callback?code=c&state=wrong', headers: { cookie: statePair } }),
    mismatch,
  );
  assert.equal(mismatch.statusCode, 403);
  assert.match(mismatch.body, /state/u);
  assert.equal(cookiePair(mismatch, SESSION_COOKIE), undefined);

  const revoked = fakeRes();
  await server.match('/feishu-auth/callback').handler(
    fakeReq({ url: '/feishu-auth/callback?error=access_denied&state=x', headers: { cookie: statePair } }),
    revoked,
  );
  assert.equal(revoked.statusCode, 403);
  assert.match(revoked.body, /access_denied/u);

  const noState = fakeRes();
  await server.match('/feishu-auth/callback').handler(fakeReq({ url: '/feishu-auth/callback?code=c&state=x' }), noState);
  assert.equal(noState.statusCode, 403);

  const upstream = fakeServer({});
  makeGate({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  }).install(upstream);
  const upstreamLogin = fakeRes();
  await upstream.match('/feishu-auth/login').handler(fakeReq({ url: '/feishu-auth/login' }), upstreamLogin);
  const upstreamState = cookiePair(upstreamLogin, STATE_COOKIE);
  const upstreamNonce = verifyPayload(secret, upstreamState.split('=')[1]).nonce;
  const upstreamRes = fakeRes();
  await upstream.match('/feishu-auth/callback').handler(
    fakeReq({ url: `/feishu-auth/callback?code=c&state=${upstreamNonce}`, headers: { cookie: upstreamState } }),
    upstreamRes,
  );
  assert.equal(upstreamRes.statusCode, 403);
  assert.match(upstreamRes.body, /ECONNREFUSED/u);
  assert.equal(cookiePair(upstreamRes, SESSION_COOKIE), undefined);
});

test('an empty allowedUsers admits any app member; a non-empty one narrows to it', async () => {
  const openServer = fakeServer({});
  makeGate({ config: configWith(), fetchImpl: feishuOk }).install(openServer);
  assert.equal((await completeLogin({ server: openServer })).callbackRes.statusCode, 303);

  const narrowServer = fakeServer({});
  makeGate({ config: configWith({ allowedUsers: ['ou_someone_else'] }), fetchImpl: feishuOk }).install(narrowServer);
  const denied = await completeLogin({ server: narrowServer });
  assert.equal(denied.callbackRes.statusCode, 403);
  assert.match(denied.callbackRes.body, /allowedUsers/u);
  assert.match(denied.callbackRes.body, /ou_1/u, 'the denied page shows the account its own open_id');
  assert.equal(cookiePair(denied.callbackRes, SESSION_COOKIE), undefined);

  const listedServer = fakeServer({});
  makeGate({ config: configWith({ allowedUsers: ['ou_1'] }), fetchImpl: feishuOk }).install(listedServer);
  assert.equal((await completeLogin({ server: listedServer })).callbackRes.statusCode, 303);
});

test('the harness handoff is bounded: a missing resolver cannot self-redirect', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(401) });
  makeGate({ entryUrl: null }).install(server);
  const res = fakeRes();
  await server.match('/').handler(fakeReq({ url: '/', headers: { cookie: sessionCookie(), accept: 'text/html' } }), res);
  assert.equal(res.statusCode, 401);
});

test('the handoff marker stops a second bounce when the harness cookie is refused', async () => {
  let served = 0;
  const server = fakeServer({ fallback: (req, res) => { served += 1; res.writeHead(401); } });
  makeGate().install(server);
  const handoff = fakeRes();
  await server.match('/').handler(fakeReq({ url: '/', headers: { cookie: sessionCookie(), accept: 'text/html' } }), handoff);
  assert.equal(handoff.statusCode, 303);
  const marker = cookiePair(handoff, HANDOFF_COOKIE);
  assert.ok(marker !== undefined, 'the handoff must be marked');
  const back = fakeRes();
  await server.match('/').handler(
    fakeReq({ url: '/', headers: { cookie: `${sessionCookie()}; ${marker}`, accept: 'text/html' } }),
    back,
  );
  assert.equal(back.statusCode, 401);
  assert.equal(served, 1);
});

test('an authenticated non-navigation request is never bounced through the exchange', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(200) });
  makeGate().install(server);
  for (const url of ['/', '/settings', '/api/session/list']) {
    const res = fakeRes();
    await server.match(url).handler(fakeReq({ url, headers: { cookie: sessionCookie() } }), res);
    assert.equal(res.statusCode, 200, `${url} must pass through`);
  }
});

test('logout clears this gate cookie, the marker, and the harness cookie', async () => {
  const server = fakeServer({});
  makeGate().install(server);
  const res = fakeRes();
  await server.match('/feishu-auth/logout').handler(
    fakeReq({ url: '/feishu-auth/logout', headers: { cookie: `${sessionCookie()}; dsh-feishu-handoff=1; dsh-auth-abc=xyz` } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  for (const name of [SESSION_COOKIE, HANDOFF_COOKIE, 'dsh-auth-abc']) {
    assert.ok(
      setCookies(res).some((cookie) => cookie.startsWith(`${name}=;`) && cookie.includes('Max-Age=0')),
      `${name} must be expired`,
    );
  }
});

test('status reports the caller own gate state', async () => {
  const server = fakeServer({});
  makeGate().install(server);
  const anonymous = fakeRes();
  await server.match('/feishu-auth/status').handler(fakeReq({ url: '/feishu-auth/status' }), anonymous);
  assert.deepEqual(JSON.parse(anonymous.body), { authenticated: false, gate: 'enforce', reason: 'no-cookie' });

  const authed = fakeRes();
  await server.match('/feishu-auth/status').handler(
    fakeReq({ url: '/feishu-auth/status', headers: { cookie: sessionCookie() } }),
    authed,
  );
  const payload = JSON.parse(authed.body);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.user.openId, 'ou_1');
});

test('missing credentials fail closed instead of opening the page', async () => {
  // The harness exports FEISHU_APP_ID / FEISHU_APP_SECRET to its children, so
  // this case has to clear them to be meaningful.
  const saved = { id: process.env.FEISHU_APP_ID, secret: process.env.FEISHU_APP_SECRET };
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  try {
    const analysis = analyzeConfig({});
    assert.equal(analysis.fatal.length, 2);
    let leaked = false;
    const server = fakeServer({ fallback: (req, res) => { leaked = true; res.writeHead(200); } });
    makeGate({ config: analysis.config, fatalProblems: analysis.fatal }).install(server);

    const res = fakeRes();
    await server.match('/').handler(fakeReq({ url: '/', headers: { accept: 'text/html' } }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(leaked, false);
    const status = fakeRes();
    await server.match('/feishu-auth/status').handler(fakeReq({ url: '/feishu-auth/status' }), status);
    assert.equal(JSON.parse(status.body).gate, 'misconfigured');
  } finally {
    if (saved.id !== undefined) process.env.FEISHU_APP_ID = saved.id;
    if (saved.secret !== undefined) process.env.FEISHU_APP_SECRET = saved.secret;
  }
});

test('a malformed allowedUsers is fatal rather than silently widening access', () => {
  const analysis = analyzeConfig({ appId: 'a', appSecret: 'b', allowedUsers: 'ou_1' });
  assert.equal(analysis.config.allowedUsers.length, 0);
  assert.match(analysis.fatal.join(' '), /allowedUsers/u);
});

test('sessionMaxAgeDays outside 1..365 falls back to the default', () => {
  assert.equal(configWith({ sessionMaxAgeDays: 30 }).sessionMaxAgeDays, 30);
  assert.equal(configWith({ sessionMaxAgeDays: 0 }).sessionMaxAgeDays, 14);
  assert.equal(configWith({ sessionMaxAgeDays: 'soon' }).sessionMaxAgeDays, 14);
});

test('credentials come from the environment when the row omits them', () => {
  process.env.FEISHU_APP_ID = 'cli_env';
  process.env.FEISHU_APP_SECRET = 'env-secret';
  try {
    const { config, fatal } = analyzeConfig({});
    assert.equal(config.appId, 'cli_env');
    assert.equal(fatal.length, 0);
  } finally {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  }
});

test('a reinstalled gate can be unwound without removing its successor', async () => {
  const server = fakeServer({ fallback: (req, res) => res.writeHead(200) });
  const disposeFirst = makeGate().install(server);
  makeGate().install(server);
  const res = fakeRes();
  await server.match('/x').handler(fakeReq({ url: '/x', headers: { accept: 'text/html' } }), res);
  assert.equal(res.statusCode, 302);
  disposeFirst();
  const after = fakeRes();
  await server.match('/x').handler(fakeReq({ url: '/x', headers: { accept: 'text/html' } }), after);
  assert.equal(after.statusCode, 302);
});
