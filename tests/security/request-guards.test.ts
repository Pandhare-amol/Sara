import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeStringEqual,
  getWebAuthnRequestContext,
  hostFromHeader,
  isHostAllowed,
  isLoopbackAddress,
  isLoopbackHost,
  isOriginAllowed,
  parseCsvSet,
} from '../../src/security/requestGuards';

test('request guard normalizes and allowlists Host values', () => {
  const allowed = new Set(['localhost', '127.0.0.1', '::1']);
  assert.equal(hostFromHeader('LOCALHOST:3000'), 'localhost');
  assert.equal(hostFromHeader('[::1]:3000'), '::1');
  assert.equal(hostFromHeader('user:pass@localhost:3000'), null);
  assert.equal(isHostAllowed('127.0.0.1:3000', allowed), true);
  assert.equal(isHostAllowed('evil.example:3000', allowed), false);
});

test('request guard accepts only same-origin or explicitly allowlisted browser origins', () => {
  const explicit = parseCsvSet('https://ui.example, https://admin.example/');
  assert.equal(isOriginAllowed('http://127.0.0.1:3000', '127.0.0.1:3000', new Set(), '3000'), true);
  assert.equal(isOriginAllowed('http://127.0.0.1:3001', '127.0.0.1:3000', new Set(), '3000'), false);
  assert.equal(isOriginAllowed('https://evil.example', '127.0.0.1:3000', new Set(), '3000'), false);
  assert.equal(isOriginAllowed('null', '127.0.0.1:3000', new Set(), '3000'), false);
  assert.equal(isOriginAllowed('https://ui.example', '127.0.0.1:3000', explicit, '3000'), true);
});

test('WebAuthn request context accepts localhost and rejects numeric relying-party IDs', () => {
  assert.deepEqual(getWebAuthnRequestContext('http://localhost:3000'), {
    rpID: 'localhost',
    origin: 'http://localhost:3000',
  });
  assert.throws(
    () => getWebAuthnRequestContext('http://127.0.0.1:3000'),
    /Use http:\/\/localhost:3000 for local passkeys/,
  );
  assert.deepEqual(getWebAuthnRequestContext('https://login.example.com', 'example.com'), {
    rpID: 'example.com',
    origin: 'https://login.example.com',
  });
  assert.throws(() => getWebAuthnRequestContext('http://login.example.com'), /require HTTPS/);
  assert.throws(() => getWebAuthnRequestContext('https://login.example.com/path'), /Invalid passkey origin/);
  assert.throws(() => getWebAuthnRequestContext('https://login.example.com', 'other.example'), /must match/);
});

test('loopback checks cover IPv4, mapped IPv4 and IPv6 loopback', () => {
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.4'), false);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('credential comparison rejects empty and mismatched secrets', () => {
  assert.equal(constantTimeStringEqual('long-enough-secret', 'long-enough-secret'), true);
  assert.equal(constantTimeStringEqual('long-enough-secret', 'long-enough-secreT'), false);
  assert.equal(constantTimeStringEqual('long-enough-secret', 'short'), false);
  assert.equal(constantTimeStringEqual('', ''), false);
});
