import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { mock } from 'node:test';
import { fetchPublicUrl, isPublicIpAddress } from '../../src/security/safeRemoteFetch';

test('public destination classifier rejects private, reserved and special-use ranges', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.31.255.255', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1',
    '2001:0::1', '2002::1', '3fff::1', 'ff02::1',
  ]) {
    assert.equal(isPublicIpAddress(address), false, `${address} must not be considered public`);
  }
});

test('public destination classifier permits ordinary global unicast addresses', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888']) {
    assert.equal(isPublicIpAddress(address), true, `${address} should be publicly routable`);
  }
});

test('approved origin is checked before DNS; a redirected origin cannot broaden scope', async () => {
  await assert.rejects(() => fetchPublicUrl('https://docs.example.com/private',
    { allowedOrigins: ['https://other.example.com'] }), /approved origin/);
});

test('safe fetch rejects local, credential-bearing and non-HTTP URLs before connecting', async () => {
  await assert.rejects(() => fetchPublicUrl('http://127.0.0.1/'), /non-public/);
  await assert.rejects(() => fetchPublicUrl('http://[::1]/'), /non-public/);
  await assert.rejects(() => fetchPublicUrl('http://localhost/'), /Localhost/);
  await assert.rejects(() => fetchPublicUrl('https://user:password@example.com/'), /credentials/);
  await assert.rejects(() => fetchPublicUrl('file:///etc/passwd'), /HTTP and HTTPS/);
});

test('safe fetch fails closed when any DNS answer is non-public', async () => {
  const dnsMock = mock.method(dns, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '10.0.0.8', family: 4 },
  ] as any);
  try {
    await assert.rejects(
      () => fetchPublicUrl('http://mixed-answer.test/'),
      /non-public IP address/,
    );
  } finally {
    dnsMock.mock.restore();
  }
});
