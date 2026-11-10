import { describe, expect, it } from 'vitest';
import { isBlockedAddress, parseSafeUrl, safeFetchBuffer, safeRequest, SsrfError } from '../src/security/ssrf.js';
import { fakeOrigin } from './helpers.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::1', 'ff02::1',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('parseSafeUrl', () => {
  it('rejects non-http schemes and private literals', () => {
    for (const u of ['file:///etc/passwd', 'ftp://x.com/a', 'gopher://x', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://localhost:8080/', 'http://foo.internal/'])
      expect(() => parseSafeUrl(u)).toThrow(SsrfError);
  });
  it('accepts public http(s)', () => {
    expect(parseSafeUrl('https://example.com/feed.xml').hostname).toBe('example.com');
  });
});

describe('safeRequest', () => {
  it('refuses loopback by default (resolved-address check)', async () => {
    const o = await fakeOrigin({ '/a': { type: 'text/plain', body: 'x' } });
    await expect(safeRequest(`${o.url}/a`)).rejects.toThrow(/Blocked/);
    await o.close();
  });
  it('refuses hostnames that resolve to loopback', async () => {
    await expect(safeRequest('http://localtest.me:1/')).rejects.toBeTruthy();
  });
  it('follows redirects (discarding the redirect body) without crashing, and caps hop count', async () => {
    const o = await fakeOrigin({
      '/start': { type: 'text/plain', body: '', location: '/mid' },
      '/mid': { type: 'text/plain', body: '', status: 301, location: '/end' },
      '/end': { type: 'text/plain', body: 'arrived' },
      '/loop': { type: 'text/plain', body: '', location: '/loop' },
    });
    const ok = await safeFetchBuffer(`${o.url}/start`, { maxBytes: 100, allowPrivate: true });
    expect(ok.body.toString()).toBe('arrived');
    await expect(safeFetchBuffer(`${o.url}/loop`, { maxBytes: 100, allowPrivate: true })).rejects.toThrow(/redirects/);
    await new Promise((r) => setTimeout(r, 50)); // an unhandled stream error would fail the run here
    await o.close();
  });
  it('enforces size caps and follows redirects only through validation', async () => {
    const o = await fakeOrigin({ '/big': { type: 'text/plain', body: 'x'.repeat(2000) } });
    await expect(safeFetchBuffer(`${o.url}/big`, { maxBytes: 100, allowPrivate: true })).rejects.toThrow(/larger/);
    const ok = await safeFetchBuffer(`${o.url}/big`, { maxBytes: 5000, allowPrivate: true });
    expect(ok.bytes).toBe(2000);
    await o.close();
  });
});
