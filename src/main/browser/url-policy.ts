import { isIP } from 'node:net';
import { BrowserError } from './errors.js';
import type { HostResolver } from './types.js';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);

function parseIpv4(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split('.').map(Number);
  return parts.length === 4 ? parts : undefined;
}

function isPrivateIpv4(address: string): boolean {
  const p = parseIpv4(address);
  if (!p) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function embeddedIpv4(address: string): string | undefined {
  let normalized: string;
  try {
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
  if (!normalized.startsWith('::ffff:')) return undefined;
  const words = normalized.slice(7).split(':');
  if (words.length !== 2 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  const [high, low] = words.map(word => Number.parseInt(word, 16));
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isPrivateAddress(address: string): boolean {
  const unwrapped = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (isPrivateIpv4(unwrapped)) return true;
  if (isIP(unwrapped) !== 6) return false;
  const normalized = unwrapped.toLowerCase();
  const embedded = embeddedIpv4(normalized);
  if (embedded && isPrivateIpv4(embedded)) return true;
  return normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff');
}

export interface UrlPolicyOptions {
  resolver?: HostResolver;
  allowPrivateNetwork?: boolean;
}

export async function canonicalizeUrl(raw: string, options: UrlPolicyOptions = {}): Promise<string> {
  const input = raw.trim();
  if (!input) throw new BrowserError('INVALID_ARGUMENT', 'URL is required');

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new BrowserError('INVALID_ARGUMENT', 'URL is invalid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserError('DANGEROUS_URL', `Protocol ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new BrowserError('DANGEROUS_URL', 'Credentials in URLs are not allowed');
  }
  if (!url.hostname) throw new BrowserError('INVALID_ARGUMENT', 'URL hostname is required');

  url.hash = '';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!options.allowPrivateNetwork) {
    if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || isPrivateAddress(hostname)) {
      throw new BrowserError('PRIVATE_NETWORK_BLOCKED', 'Private network URLs are not allowed');
    }
    if (options.resolver && isIP(hostname) === 0) {
      let addresses: ReadonlyArray<string>;
      try {
        addresses = await options.resolver.resolve(hostname);
      } catch {
        throw new BrowserError('DANGEROUS_URL', 'Hostname could not be safely resolved', true);
      }
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new BrowserError('PRIVATE_NETWORK_BLOCKED', 'Hostname resolves to a private network');
      }
    }
  }
  return url.toString();
}
