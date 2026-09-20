import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chromeCookieKey,
  chromeProfiles,
  chromeSafeStorageSecret,
  decryptChromeValue,
  readChromeCookies,
  toElectronCookie,
  type ChromeCookieRow,
} from '../src/main/browser/chrome-cookies';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function chromeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilion-chrome-'));
  scratch.push(root);
  return root;
}

/** Mirrors how Chrome stores a value on macOS: "v10" + AES-128-CBC over host hash + plaintext. */
function encryptLikeChrome(key: Buffer, host: string, value: string, withHostHash = true): Buffer {
  const body = withHostHash
    ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value, 'utf8')])
    : Buffer.from(value, 'utf8');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([Buffer.from('v10', 'utf8'), cipher.update(body), cipher.final()]);
}

const row = (overrides: Partial<ChromeCookieRow> = {}): ChromeCookieRow => ({
  host: '.example.com',
  name: 'session',
  value: 'abc',
  path: '/',
  expiresUtc: '0',
  secure: 1,
  httpOnly: 1,
  sameSite: 1,
  sourcePort: 443,
  ...overrides,
});

describe('Chrome cookie import', () => {
  it('decrypts a value and drops the host hash Chrome prepends', () => {
    const key = chromeCookieKey('test-secret');
    const encrypted = encryptLikeChrome(key, '.example.com', 'session-token');
    expect(decryptChromeValue(encrypted, key, '.example.com')).toBe('session-token');
  });

  it('decrypts a value stored before Chrome prefixed the host hash', () => {
    const key = chromeCookieKey('test-secret');
    const encrypted = encryptLikeChrome(key, '.example.com', 'plain-token', false);
    expect(decryptChromeValue(encrypted, key, '.example.com')).toBe('plain-token');
  });

  it('refuses a value that was not encrypted with this key', () => {
    const encrypted = encryptLikeChrome(chromeCookieKey('one'), '.example.com', 'secret');
    expect(decryptChromeValue(encrypted, chromeCookieKey('two'), '.example.com')).toBeUndefined();
  });

  it('keeps a host-wide cookie applying to subdomains', () => {
    expect(toElectronCookie(row())).toMatchObject({
      url: 'https://example.com/',
      domain: '.example.com',
      name: 'session',
      value: 'abc',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
  });

  it('addresses a host-only cookie over the scheme it was stored for', () => {
    expect(toElectronCookie(row({ host: 'example.com', secure: 0, sourcePort: 80 }))).toMatchObject(
      { url: 'http://example.com/', domain: 'example.com', secure: false },
    );
  });

  it.each([
    [-1, 'unspecified'],
    [0, 'no_restriction'],
    [1, 'lax'],
    [2, 'strict'],
  ])('maps Chrome sameSite %s', (sameSite, expected) => {
    expect(toElectronCookie(row({ sameSite }))?.sameSite).toBe(expected);
  });

  it('converts the Chrome epoch into an expiry the session can store', () => {
    // 13450499928469051 µs since 1601-01-01 is 1806026328 seconds since the Unix epoch.
    const cookie = toElectronCookie(row({ expiresUtc: '13450499928469051' }));
    expect(cookie!.expirationDate).toBe(1806026328);
    expect(new Date(cookie!.expirationDate! * 1000).toISOString()).toBe('2027-03-26T01:58:48.000Z');
  });

  it('leaves a session cookie without an expiry', () => {
    expect(toElectronCookie(row({ expiresUtc: '0' }))).not.toHaveProperty('expirationDate');
  });

  it('skips a row whose host cannot form a URL', () => {
    expect(toElectronCookie(row({ host: '' }))).toBeUndefined();
  });
});

describe('reading a Chrome installation', () => {
  it('lists profiles by the name the user gave them', async () => {
    const root = await chromeRoot();
    await writeFile(
      join(root, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: { Default: { name: '工作' }, 'Profile 2': { name: '私人' } },
          last_used: 'Profile 2',
        },
      }),
    );
    await expect(chromeProfiles(root)).resolves.toEqual([
      { id: 'Default', name: '工作' },
      { id: 'Profile 2', name: '私人' },
    ]);
  });

  it('falls back to the default profile when there is no profile list', async () => {
    const root = await chromeRoot();
    await mkdir(join(root, 'Default'), { recursive: true });
    await expect(chromeProfiles(root)).resolves.toEqual([{ id: 'Default', name: 'Default' }]);
  });

  it('reads a cookie store without disturbing the original file', async () => {
    const root = await chromeRoot();
    const profile = join(root, 'Default');
    await mkdir(profile, { recursive: true });
    const key = chromeCookieKey('test-secret');
    const database = new DatabaseSync(join(profile, 'Cookies'));
    database.exec(
      'CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, source_port INTEGER)',
    );
    const insert = database.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(
      '.example.com',
      'session',
      encryptLikeChrome(key, '.example.com', 'token'),
      '/',
      0,
      1,
      1,
      1,
      443,
    );
    insert.run(
      '.example.com',
      'broken',
      Buffer.from('v10not-really-encrypted'),
      '/',
      0,
      1,
      0,
      1,
      443,
    );
    database.close();

    const result = await readChromeCookies({
      profileDirectory: profile,
      key,
      scratchDirectory: join(root, 'scratch'),
    });
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]).toMatchObject({ name: 'session', value: 'token' });
    expect(result.unreadable).toBe(1);
  });

  it('reports a refused Keychain prompt as its own failure', async () => {
    await expect(
      chromeSafeStorageSecret(async () => {
        throw new Error('User canceled the operation.');
      }),
    ).rejects.toThrow('钥匙串');
  });

  it('trims the secret the Keychain hands back', async () => {
    await expect(chromeSafeStorageSecret(async () => 'shhh\n')).resolves.toBe('shhh');
  });
});
