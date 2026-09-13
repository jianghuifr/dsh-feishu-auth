import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, isNavigationRequest, normalizeAuthority, requestBaseUrl, sanitizeNext } from '../lib/urls.js';

function req({ method = 'GET', headers = {}, encrypted = false, remoteAddress = '10.0.0.9' } = {}) {
  return { method, headers, socket: { encrypted, remoteAddress } };
}

test('an authority must be a bare host', () => {
  assert.equal(normalizeAuthority('Example.COM:3080'), 'example.com:3080');
  assert.equal(normalizeAuthority('[::1]:3080'), '[::1]:3080');
  assert.equal(normalizeAuthority('127.0.0.1'), '127.0.0.1');
  for (const bad of ['', 'a/b', 'a?b', 'a#b', 'user@host', 'a\\b', 'a b', undefined, 42, 'x'.repeat(300)]) {
    assert.equal(normalizeAuthority(bad), undefined, `expected ${String(bad)} to be rejected`);
  }
});

test('the base URL follows scheme and Host, and a proxy may set the scheme', () => {
  assert.equal(requestBaseUrl(req({ headers: { host: 'dsh.example.com' } })), 'http://dsh.example.com');
  assert.equal(
    requestBaseUrl(req({ headers: { host: 't.example.com', 'x-forwarded-proto': 'https, http' } })),
    'https://t.example.com',
  );
  assert.equal(requestBaseUrl(req({ headers: { host: 't.example.com', 'x-forwarded-proto': 'ftp' } })), 'http://t.example.com');
  assert.equal(requestBaseUrl(req({ headers: { host: 't.example.com' }, encrypted: true })), 'https://t.example.com');
  assert.equal(requestBaseUrl(req({ headers: { host: 'not a host' } })), undefined);
});

test('next never escapes the origin', () => {
  assert.equal(sanitizeNext('/settings?x=1'), '/settings?x=1');
  assert.equal(sanitizeNext(undefined), '/');
  for (const hostile of ['//evil.test', 'https://evil.test', '/\\evil.test', '\\\\evil', '/a\u0000b', '', 'no-slash', 'x'.repeat(4096)]) {
    assert.equal(sanitizeNext(hostile), '/', `expected ${JSON.stringify(hostile)} to collapse to /`);
  }
});

test('navigation detection separates browsers from programmatic callers', () => {
  assert.equal(isNavigationRequest(req({ headers: { accept: 'text/html,application/xhtml+xml' } })), true);
  assert.equal(isNavigationRequest(req({ headers: { accept: '*/*' } })), false);
  assert.equal(isNavigationRequest(req({ method: 'POST', headers: { accept: 'text/html' } })), false);
  assert.equal(isNavigationRequest(req({ headers: { 'sec-fetch-mode': 'navigate' } })), true);
  assert.equal(isNavigationRequest(req({ headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } })), false);
});

test('the client address keeps the socket peer and the first proxy hop', () => {
  assert.equal(clientAddress(req()), '10.0.0.9');
  assert.equal(clientAddress(req({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } })), '203.0.113.5 via 10.0.0.9');
});
