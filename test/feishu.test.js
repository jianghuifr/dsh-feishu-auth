import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FeishuApiError, buildAuthorizeUrl, exchangeCode, fetchUserInfo } from '../lib/feishu.js';

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('the authorize URL carries what the platform requires', () => {
  const url = new URL(
    buildAuthorizeUrl({ clientId: 'cli_x', redirectUri: 'https://dsh.example.com/feishu-auth/callback', state: 'n1' }),
  );
  assert.equal(url.origin, 'https://accounts.feishu.cn');
  assert.equal(url.pathname, '/open-apis/authen/v1/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cli_x');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://dsh.example.com/feishu-auth/callback');
  assert.equal(url.searchParams.get('state'), 'n1');
});

test('the token exchange posts a form body and reads the flat v3 shape', async () => {
  let seen;
  const result = await exchangeCode({
    clientId: 'cli_x',
    clientSecret: 'secret',
    code: 'the-code',
    redirectUri: 'https://dsh.example.com/feishu-auth/callback',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return jsonResponse({ code: 0, access_token: 'u-token' });
    },
  });
  assert.equal(seen.url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body.get('grant_type'), 'authorization_code');
  assert.equal(seen.init.body.get('client_secret'), 'secret');
  assert.equal(seen.init.body.get('redirect_uri'), 'https://dsh.example.com/feishu-auth/callback');
  assert.equal(result.accessToken, 'u-token');
});

test('the token exchange also reads the nested v2 shape', async () => {
  const result = await exchangeCode({
    clientId: 'c',
    clientSecret: 's',
    code: 'x',
    redirectUri: 'https://x/cb',
    fetchImpl: async () => jsonResponse({ code: 0, data: { access_token: 'nested' } }),
  });
  assert.equal(result.accessToken, 'nested');
});

test('a refused exchange reports the platform reason without leaking the secret', async () => {
  await assert.rejects(
    exchangeCode({
      clientId: 'c',
      clientSecret: 'super-secret',
      code: 'x',
      redirectUri: 'https://x/cb',
      fetchImpl: async () => jsonResponse({ code: 20002, error_description: 'The client secret is invalid.' }, 400),
    }),
    (error) => {
      assert.ok(error instanceof FeishuApiError);
      assert.match(error.message, /client secret is invalid/u);
      assert.equal(error.message.includes('super-secret'), false);
      return true;
    },
  );
});

test('a non-JSON upstream response is reported as such', async () => {
  await assert.rejects(
    exchangeCode({
      clientId: 'c',
      clientSecret: 's',
      code: 'x',
      redirectUri: 'https://x/cb',
      fetchImpl: async () => new Response('<html>gateway</html>', { status: 502 }),
    }),
    /非 JSON/u,
  );
});

test('user info is read with a bearer token and mapped to flat fields', async () => {
  let authorization;
  const user = await fetchUserInfo({
    accessToken: 'u-token',
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return jsonResponse({ code: 0, msg: 'success', data: { open_id: 'ou_1', name: '张三', tenant_key: 'tk_1' } });
    },
  });
  assert.equal(authorization, 'Bearer u-token');
  assert.deepEqual(user, { open_id: 'ou_1', union_id: undefined, user_id: undefined, name: '张三', tenant_key: 'tk_1' });
});

test('an upstream error and a missing open_id are both fatal', async () => {
  await assert.rejects(
    fetchUserInfo({ accessToken: 't', fetchImpl: async () => jsonResponse({ code: 20005, msg: 'invalid token' }) }),
    /invalid token/u,
  );
  await assert.rejects(
    fetchUserInfo({ accessToken: 't', fetchImpl: async () => jsonResponse({ code: 0, data: { name: 'x' } }) }),
    /open_id/u,
  );
});
