import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';

/** Chrome on macOS wraps every value as "v10" + AES-128-CBC under a Keychain-derived key. */
const VERSION_TAG = 'v10';
const KEY_ITERATIONS = 1003;
const KEY_LENGTH = 16;
/** Chrome's epoch is 1601-01-01; this is the offset to the Unix epoch in seconds. */
const EPOCH_OFFSET_SECONDS = 11_644_473_600;

export interface ChromeCookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  /** Microseconds since 1601-01-01, carried as text because it exceeds a safe integer. */
  expiresUtc: string;
  secure: number;
  httpOnly: number;
  sameSite: number;
  sourcePort: number;
}

export interface ElectronCookie {
  url: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

export function chromeCookieKey(secret: string): Buffer {
  return pbkdf2Sync(secret, 'saltysalt', KEY_ITERATIONS, KEY_LENGTH, 'sha1');
}

/**
 * Returns undefined rather than throwing when the key is wrong, so one unreadable row cannot
 * abort an import of thousands.
 */
export function decryptChromeValue(
  encrypted: Buffer,
  key: Buffer,
  host: string,
): string | undefined {
  if (encrypted.subarray(0, 3).toString('utf8') !== VERSION_TAG) return undefined;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
  const padding = plain.at(-1) ?? 0;
  if (padding < 1 || padding > 16 || padding > plain.length) return undefined;
  plain = plain.subarray(0, plain.length - padding);
  // Chrome 130 and later prepend the SHA-256 of the host, which is not part of the value.
  const hash = createHash('sha256').update(host).digest();
  if (plain.length >= hash.length && plain.subarray(0, hash.length).equals(hash))
    plain = plain.subarray(hash.length);
  const text = plain.toString('utf8');
  return text.includes('�') ? undefined : text;
}

const SAME_SITE: Record<number, ElectronCookie['sameSite']> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};

export function toElectronCookie(row: ChromeCookieRow): ElectronCookie | undefined {
  const bare = row.host.startsWith('.') ? row.host.slice(1) : row.host;
  if (!bare || !row.name) return undefined;
  const scheme = row.secure ? 'https' : 'http';
  let url: string;
  try {
    url = new URL(`${scheme}://${bare}${row.path || '/'}`).toString();
  } catch {
    return undefined;
  }
  const expires = Math.floor(Number(row.expiresUtc) / 1_000_000 - EPOCH_OFFSET_SECONDS);
  return {
    url,
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || '/',
    secure: Boolean(row.secure),
    httpOnly: Boolean(row.httpOnly),
    sameSite: SAME_SITE[row.sameSite] ?? 'unspecified',
    ...(row.expiresUtc !== '0' && Number.isFinite(expires) && expires > 0
      ? { expirationDate: expires }
      : {}),
  };
}

export interface ChromeProfile {
  id: string;
  name: string;
}

/** Reads the profile list Chrome keeps in Local State, falling back to the default directory. */
export async function chromeProfiles(root: string): Promise<ChromeProfile[]> {
  const { readFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    const entries = Object.entries(state.profile?.info_cache ?? {});
    if (entries.length) return entries.map(([id, info]) => ({ id, name: info.name || id }));
  } catch {
    /* an older or partial installation still has a Default directory */
  }
  try {
    if ((await stat(join(root, 'Default'))).isDirectory())
      return [{ id: 'Default', name: 'Default' }];
  } catch {
    /* no readable profile at all */
  }
  return [];
}

/** Injectable so tests never touch the real Keychain and the prompt stays a main-process concern. */
export type SecretReader = (command: string, args: readonly string[]) => Promise<string>;

export async function chromeSafeStorageSecret(read: SecretReader): Promise<string> {
  try {
    const secret = await read('security', [
      'find-generic-password',
      '-w',
      '-s',
      'Chrome Safe Storage',
      '-a',
      'Chrome',
    ]);
    const trimmed = secret.trim();
    if (!trimmed) throw new Error('empty');
    return trimmed;
  } catch {
    throw new Error('无法读取钥匙串中的 Chrome 密钥，请在系统提示中允许访问后重试');
  }
}

export interface CookieReadResult {
  cookies: ElectronCookie[];
  unreadable: number;
}

/**
 * Copies the store before reading it, so an open Chrome keeps its lock and the original file is
 * never touched by this process.
 */
export async function readChromeCookies(options: {
  profileDirectory: string;
  key: Buffer;
  scratchDirectory: string;
}): Promise<CookieReadResult> {
  const { copyFile, mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  await mkdir(options.scratchDirectory, { recursive: true });
  const copy = join(options.scratchDirectory, `cookies-${Date.now()}.db`);
  await copyFile(join(options.profileDirectory, 'Cookies'), copy);
  try {
    const database = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = database
        .prepare(
          'SELECT host_key, name, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc,' +
            ' is_secure, is_httponly, samesite, source_port FROM cookies',
        )
        .all() as unknown as Array<Record<string, unknown>>;
      const cookies: ElectronCookie[] = [];
      let unreadable = 0;
      for (const raw of rows) {
        const host = String(raw.host_key ?? '');
        const value = decryptChromeValue(
          Buffer.from(raw.encrypted_value as Uint8Array),
          options.key,
          host,
        );
        if (value === undefined) {
          unreadable += 1;
          continue;
        }
        const cookie = toElectronCookie({
          host,
          name: String(raw.name ?? ''),
          value,
          path: String(raw.path ?? '/'),
          expiresUtc: String(raw.expires_utc ?? '0'),
          secure: Number(raw.is_secure ?? 0),
          httpOnly: Number(raw.is_httponly ?? 0),
          sameSite: Number(raw.samesite ?? -1),
          sourcePort: Number(raw.source_port ?? 0),
        });
        if (cookie) cookies.push(cookie);
        else unreadable += 1;
      }
      return { cookies, unreadable };
    } finally {
      database.close();
    }
  } finally {
    await rm(copy, { force: true });
  }
}
