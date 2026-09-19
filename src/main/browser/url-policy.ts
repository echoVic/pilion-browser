import { isIP } from 'node:net';
import { BrowserError } from './errors.js';
import type { HostResolver } from './types.js';

const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain']);

function parseIpv4(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split('.').map(Number);
  return parts.length === 4 ? parts : undefined;
}

/**
 * RFC 2544 benchmarking range. Proxies running in fake-IP mode (Clash, sing-box,
 * Shadowrocket) answer every DNS query from this pool, so an address resolved here
 * is a proxy indirection rather than a host reachable on the local network.
 */
function isBenchmarkingIpv4(address: string): boolean {
  const p = parseIpv4(address);
  if (!p) return false;
  const [a, b] = p;
  return a === 198 && (b === 18 || b === 19);
}

function isPrivateIpv4(address: string): boolean {
  const p = parseIpv4(address);
  if (!p) return false;
  const [a, b, c] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    isBenchmarkingIpv4(address) ||
    a >= 224
  );
}

/** Expands any accepted IPv6 spelling into its eight 16-bit groups. */
function expandIpv6(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.toLowerCase();
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const quad = dotted[1].split('.').map(Number);
    const high = ((quad[0] << 8) | quad[1]).toString(16);
    const low = ((quad[2] << 8) | quad[3]).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }
  const [head, tail] = text.split('::');
  const words = (chunk: string) =>
    chunk ? chunk.split(':').map((word) => Number.parseInt(word, 16)) : [];
  const left = words(head);
  if (tail === undefined) return left.length === 8 ? left : undefined;
  const right = words(tail);
  const gap = 8 - left.length - right.length;
  return gap < 0 ? undefined : [...left, ...Array<number>(gap).fill(0), ...right];
}

/**
 * IPv4 carried inside IPv6. Every transition format reaches the embedded host, so a
 * loopback or LAN address wrapped in one of them has to classify the same as the bare v4.
 */
function embeddedIpv4(groups: number[]): string | undefined {
  const quadAt = (index: number) =>
    `${groups[index] >> 8}.${groups[index] & 0xff}.${groups[index + 1] >> 8}.${groups[index + 1] & 0xff}`;
  const leadingZeros = (count: number) => groups.slice(0, count).every((word) => word === 0);
  if (leadingZeros(5) && groups[5] === 0xffff) return quadAt(6); // ::ffff:a.b.c.d mapped
  if (leadingZeros(4) && groups[4] === 0xffff && groups[5] === 0) return quadAt(6); // translated
  if (leadingZeros(6)) return quadAt(6); // ::a.b.c.d compatible
  if (groups[0] === 0x2002) return quadAt(1); // 2002:a.b.c.d::/16 6to4
  return undefined;
}

export function isPrivateAddress(address: string): boolean {
  const unwrapped = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (isPrivateIpv4(unwrapped)) return true;
  const groups = expandIpv6(unwrapped);
  if (!groups) return false;
  const embedded = embeddedIpv4(groups);
  if (embedded && isPrivateIpv4(embedded)) return true;
  const [first] = groups;
  return (
    first < 0x2000 || // everything below global unicast, including ::, ::1 and NAT64
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xffc0) === 0xfec0 || // fec0::/10 site local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** True for the fake-IP pool itself, including its IPv4-mapped IPv6 spelling. */
export function isBenchmarkingAddress(address: string): boolean {
  const unwrapped = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (isBenchmarkingIpv4(unwrapped)) return true;
  const groups = expandIpv6(unwrapped);
  if (!groups) return false;
  const embedded = embeddedIpv4(groups);
  return embedded !== undefined && isBenchmarkingIpv4(embedded);
}

/**
 * Applies to addresses a resolver returned rather than to a host typed into the URL.
 * A URL that names the fake-IP pool directly stays blocked; only the mapping a proxy
 * hands back for a public hostname is allowed through.
 */
export function isBlockedResolvedAddress(address: string): boolean {
  return isPrivateAddress(address) && !isBenchmarkingAddress(address);
}

export interface UrlPolicyOptions {
  resolver?: HostResolver;
  allowPrivateNetwork?: boolean;
}

/**
 * "example.com:8080" is a host and a port to everyone typing in an address bar, but it also
 * matches the shape of a scheme. Anything whose colon is followed only by a port number is
 * therefore read as a host, which keeps "javascript:alert(1)" and "data:…" on the scheme path.
 */
function hasScheme(input: string): boolean {
  if (/^[a-z][a-z\d.+-]*:\d+(?:[/?#]|$)/i.test(input)) return false;
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

export async function canonicalizeUrl(
  raw: string,
  options: UrlPolicyOptions = {},
): Promise<string> {
  const input = raw.trim();
  if (!input) throw new BrowserError('INVALID_ARGUMENT', 'URL is required');
  if (input === 'about:blank') return input;

  let url: URL;
  try {
    url = new URL(hasScheme(input) ? input : `https://${input}`);
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
  // A fully qualified name keeps its root label, so "localhost." has to match "localhost".
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  if (!options.allowPrivateNetwork) {
    if (
      BLOCKED_HOSTS.has(hostname) ||
      hostname.endsWith('.localhost') ||
      isPrivateAddress(hostname)
    ) {
      throw new BrowserError('PRIVATE_NETWORK_BLOCKED', 'Private network URLs are not allowed');
    }
    if (options.resolver && isIP(hostname) === 0) {
      let addresses: ReadonlyArray<string>;
      try {
        addresses = await options.resolver.resolve(hostname);
      } catch {
        throw new BrowserError('DANGEROUS_URL', 'Hostname could not be safely resolved', true);
      }
      if (addresses.length === 0 || addresses.some(isBlockedResolvedAddress)) {
        throw new BrowserError('PRIVATE_NETWORK_BLOCKED', 'Hostname resolves to a private network');
      }
    }
  }
  return url.toString();
}
