import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server as HttpServer,
} from 'node:http';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { BrowserError } from './errors.js';
import { isPrivateAddress } from './url-policy.js';
import type { HostResolver } from './types.js';

export interface PinnedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
}

type Dial = (
  options: { host: string; port: number; family: 4 | 6 },
  onConnect?: () => void,
) => Socket;
type RequestFactory = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

export interface ControlledProxyOptions {
  resolver: HostResolver;
  dial?: Dial;
  request?: RequestFactory;
}

/**
 * Loopback-only forward proxy. DNS is resolved once per request and the resulting
 * public IP is pinned into the outbound socket; host headers and TLS SNI remain end-to-end.
 */
export class ControlledNetworkProxy {
  private readonly server: HttpServer;
  private readonly dial: Dial;
  private readonly requestFactory: RequestFactory;
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly options: ControlledProxyOptions) {
    this.dial = options.dial ?? ((target, connected) => netConnect(target, connected));
    this.requestFactory = options.request ?? httpRequest;
    this.server = createServer((request, response) => {
      void this.forwardHttp(request, response);
    });
    this.server.on('connect', (request, client, head) => {
      void this.forwardConnect(request, client, head);
    });
    this.server.on('upgrade', (request, client, head) => {
      void this.forwardUpgrade(request, client, head);
    });
    this.server.on('connection', (socket) => this.track(socket));
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  async listen(): Promise<{ host: '127.0.0.1'; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Controlled proxy failed to bind TCP');
    return { host: '127.0.0.1', port: address.port };
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    for (const socket of this.sockets) socket.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private track<T extends Duplex>(socket: T): T {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  private async forwardHttp(
    incoming: IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      const url = parseAbsoluteUrl(incoming.url, 'http:');
      if (url.protocol !== 'http:')
        throw new BrowserError('DANGEROUS_URL', 'HTTPS must use CONNECT');
      const target = await resolvePinnedTarget(
        url.hostname,
        portOf(url, 80),
        this.options.resolver,
      );
      if (incoming.destroyed || response.destroyed) return;
      const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const outbound = this.requestFactory(
        {
          host: target.address,
          family: target.family,
          port: target.port,
          method: incoming.method,
          path: `${url.pathname}${url.search}`,
          headers,
          lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
          upstream.pipe(response);
        },
      );
      outbound.on('error', () => failHttp(response));
      incoming.on('aborted', () => outbound.destroy());
      incoming.pipe(outbound);
    } catch {
      failHttp(response);
    }
  }

  private async forwardConnect(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const authority = parseAuthority(request.url, 443);
      const target = await resolvePinnedTarget(
        authority.hostname,
        authority.port,
        this.options.resolver,
      );
      if (client.destroyed) return;
      const upstream = this.track(
        this.dial({ host: target.address, port: target.port, family: target.family }),
      );
      upstream.once('connect', () => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Pilion\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      tunnelFailClosed(client, upstream);
    } catch {
      denyTunnel(client);
    }
  }

  private async forwardUpgrade(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const url = parseAbsoluteUrl(request.url, 'ws:');
      if (url.protocol !== 'ws:')
        throw new BrowserError('DANGEROUS_URL', 'Secure WebSocket must use CONNECT');
      const target = await resolvePinnedTarget(
        url.hostname,
        portOf(url, 80),
        this.options.resolver,
      );
      if (client.destroyed) return;
      const upstream = this.track(
        this.dial({ host: target.address, port: target.port, family: target.family }),
      );
      upstream.once('connect', () => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        const headers = Object.entries({ ...request.headers, host: url.host }).flatMap(
          ([name, value]) =>
            value === undefined
              ? []
              : [`${name}: ${Array.isArray(value) ? value.join(', ') : value}`],
        );
        upstream.write(
          `${request.method ?? 'GET'} ${url.pathname}${url.search} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`,
        );
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      tunnelFailClosed(client, upstream);
    } catch {
      denyTunnel(client);
    }
  }
}

export async function resolvePinnedTarget(
  hostname: string,
  port: number,
  resolver: HostResolver,
): Promise<PinnedTarget> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new BrowserError('INVALID_ARGUMENT', 'Invalid proxy target');
  const addresses = await resolver.resolve(normalized);
  if (
    !addresses.length ||
    addresses.some((address) => isIP(address) === 0 || isPrivateAddress(address))
  ) {
    throw new BrowserError(
      'PRIVATE_NETWORK_BLOCKED',
      'Proxy target resolved to a private or invalid address',
    );
  }
  const address = addresses[0];
  const family = isIP(address) as 4 | 6;
  return { hostname: normalized, address, family, port };
}

function parseAbsoluteUrl(raw: string | undefined, expected: 'http:' | 'ws:'): URL {
  if (!raw) throw new BrowserError('INVALID_ARGUMENT', 'Proxy request URL is missing');
  const url = new URL(raw);
  if (url.protocol !== expected || url.username || url.password || !url.hostname)
    throw new BrowserError('DANGEROUS_URL', 'Proxy request target is not allowed');
  return url;
}
function parseAuthority(
  raw: string | undefined,
  fallbackPort: number,
): { hostname: string; port: number } {
  if (!raw) throw new BrowserError('INVALID_ARGUMENT', 'CONNECT authority is missing');
  const url = new URL(`https://${raw}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new BrowserError('DANGEROUS_URL', 'CONNECT authority is not allowed');
  }
  return { hostname: url.hostname, port: portOf(url, fallbackPort) };
}
function portOf(url: URL, fallback: number): number {
  return url.port ? Number(url.port) : fallback;
}
function failHttp(response: import('node:http').ServerResponse): void {
  if (!response.headersSent)
    response.writeHead(502, { connection: 'close', 'content-type': 'text/plain' });
  response.end('Blocked by Pilion network policy');
}
function denyTunnel(socket: Duplex): void {
  if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
}
function tunnelFailClosed(client: Duplex, upstream: Socket): void {
  upstream.on('error', () => denyTunnel(client));
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
}
