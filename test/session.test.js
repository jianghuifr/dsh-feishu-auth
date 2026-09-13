import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  cookieNames,
  expiredCookie,
  generateToken,
  loadOrCreateSecret,
  parseCookies,
  readCookie,
  safeEqual,
  serializeCookie,
  signPayload,
  verifyPayload,
} from '../lib/session.js';

const secret = randomBytes(32);

test('signed payloads round-trip', () => {
  const payload = verifyPayload(secret, signPayload(secret, { kind: 'session', sub: 'ou_1', exp: 42 }));
  assert.equal(payload.kind, 'session');
  assert.equal(payload.sub, 'ou_1');
  assert.equal(payload.exp, 42);
});

test('a tampered body, signature, or version is rejected', () => {
  const [version, body, signature] = signPayload(secret, { kind: 'session', sub: 'ou_1' }).split('.');
  // Every single-character signature flip must be rejected. Replacing the last character
  // with a fixed letter made this flaky: a 1-in-64 chance of rebuilding the original string.
  const original = signature.at(-1);
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    if (char === original) continue;
    assert.equal(verifyPayload(secret, `${version}.${body}.${signature.slice(0, -1)}${char}`), undefined);
  }
  const tamperedBody = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyPayload(secret, `${version}.${tamperedBody}.${signature}`), undefined);
  assert.equal(verifyPayload(secret, `v2.${body}.${signature}`), undefined);
  assert.equal(verifyPayload(secret, `${version}.${body}`), undefined);
  assert.equal(verifyPayload(randomBytes(32), signPayload(secret, { kind: 'session' })), undefined);
  assert.equal(verifyPayload(secret, undefined), undefined);
  // A non-canonical base64 spelling of the same bytes must not verify.
  assert.equal(verifyPayload(secret, `v1.${body}==.${signature}`), undefined);
});

test('a non-object payload is rejected rather than trusted', () => {
  for (const payload of ['text', ['a'], null]) {
    assert.equal(verifyPayload(secret, signPayload(secret, payload)), undefined);
  }
});

test('cookie parsing and serialization', () => {
  const header = 'a=1; dsh-feishu-session=abc.def.ghi; dsh-auth-xyz=zzz';
  assert.equal(readCookie(header, 'dsh-feishu-session'), 'abc.def.ghi');
  assert.deepEqual(cookieNames(header), ['a', 'dsh-feishu-session', 'dsh-auth-xyz']);
  assert.equal(readCookie(header, 'missing'), undefined);
  assert.equal(parseCookies(undefined).size, 0);
  assert.match(
    serializeCookie('dsh-feishu-session', 'v', { maxAgeSeconds: 3600, secure: true }),
    /^dsh-feishu-session=v; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$/u,
  );
  assert.match(expiredCookie('dsh-feishu-session'), /Max-Age=0/u);
  assert.doesNotMatch(serializeCookie('x', 'y', { maxAgeSeconds: 1 }), /Secure/u);
});

test('safeEqual only accepts identical strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(generateToken(24), generateToken(24)), false);
});

test('the signing secret is created once and reused', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-feishu-auth-')), 'nested', 'session-secret');
  const first = loadOrCreateSecret(file);
  assert.equal(first.byteLength, 32);
  assert.deepEqual(first, loadOrCreateSecret(file));
});
