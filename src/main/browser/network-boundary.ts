import type { Session } from 'electron';
import { lookup } from 'node:dns/promises';
import { canonicalizeUrl } from './url-policy.js';
import type { HostResolver } from './types.js';

const REQUEST_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

/** Installs the fail-closed request boundary for every request in the untrusted partition. */
export function installNetworkBoundary(
  target: Session,
  resolver: HostResolver = dnsResolver(),
): void {
  target.webRequest.onBeforeRequest({ urls: REQUEST_URLS }, (details, callback) => {
    void validateNetworkRequestUrl(details.url, resolver).then(
      () => callback({ cancel: false }),
      () => callback({ cancel: true }),
    );
  });
}

/** WebSockets use the same host/DNS policy as their corresponding HTTP transport. */
export async function validateNetworkRequestUrl(
  raw: string,
  resolver: HostResolver,
): Promise<void> {
  const candidate = new URL(raw);
  if (candidate.protocol === 'ws:') candidate.protocol = 'http:';
  else if (candidate.protocol === 'wss:') candidate.protocol = 'https:';
  else if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:')
    throw new Error('Unsupported network protocol');
  await canonicalizeUrl(candidate.toString(), { resolver });
}

function dnsResolver(): HostResolver {
  return {
    resolve: async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
  };
}
