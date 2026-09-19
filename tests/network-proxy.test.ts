import {
  request as makeRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { connect as connectClient, type Socket } from 'node:net';
import { Duplex, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlledNetworkProxy } from '../src/main/browser/index';

const proxies: ControlledNetworkProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

function rebindingResolver() {
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(['93.184.216.34'])
    .mockResolvedValueOnce(['127.0.0.1']);
  return { resolve };
}

function rawProxyRequest(port: number, payload: string, expected: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectClient({ host: '127.0.0.1', port }, () => socket.write(payload));
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy response timed out: ${received}`));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
      if (expected.test(received)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function fakeRequestFactory(seen: RequestOptions[]) {
  return (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    seen.push(options);
    const request = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    request.once('finish', () => {
      const response = Readable.from(['ok']) as IncomingMessage;
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = { 'content-type': 'text/plain' };
      callback(response);
    });
    return request as ClientRequest;
  };
}

function recordingDial(written: string[], response: string) {
  return (target: { host: string; port: number; family: 4 | 6 }): Socket => {
    void target;
    let answered = false;
    const socket = new Duplex({
      read() {
        return undefined;
      },
      write(chunk, _encoding, done) {
        written.push(String(chunk));
        if (!answered && response) {
          answered = true;
          setImmediate(() => socket.push(response));
        }
        done();
      },
    }) as Socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
}

function fakeDial(seen: Array<{ host: string; port: number; family: 4 | 6 }>, response: string) {
  return (target: { host: string; port: number; family: 4 | 6 }): Socket => {
    seen.push(target);
    let answered = false;
    const socket = new Duplex({
      read() {
        return undefined;
      },
      write(_chunk, _encoding, done) {
        if (!answered && response) {
          answered = true;
          setImmediate(() => socket.push(response));
        }
        done();
      },
    }) as Socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
}

describe('ControlledNetworkProxy DNS pinning', () => {
  it('pins an HTTP request to the single validated lookup while preserving Host', async () => {
    const resolver = rebindingResolver();
    const outbound: RequestOptions[] = [];
    const proxy = new ControlledNetworkProxy({ resolver, request: fakeRequestFactory(outbound) });
    proxies.push(proxy);
    const address = await proxy.listen();

    const response = await new Promise<string>((resolve, reject) => {
      const request = makeRequest(
        {
          host: address.host,
          port: address.port,
          path: 'http://example.test/path?q=1',
          headers: { host: 'example.test' },
        },
        (result) => {
          let body = '';
          result.setEncoding('utf8');
          result.on('data', (chunk) => {
            body += chunk;
          });
          result.on('end', () => resolve(body));
        },
      );
      request.on('error', reject);
      request.end();
    });

    expect(response).toBe('ok');
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ host: '93.184.216.34', family: 4, port: 80 });
    expect(outbound[0].headers).toMatchObject({ host: 'example.test' });
  });

  it('forwards through a fake-IP address a proxy returns for a public hostname', async () => {
    const resolver = { resolve: vi.fn().mockResolvedValue(['198.18.2.16']) };
    const outbound: RequestOptions[] = [];
    const proxy = new ControlledNetworkProxy({ resolver, request: fakeRequestFactory(outbound) });
    proxies.push(proxy);
    const address = await proxy.listen();

    const response = await new Promise<string>((resolve, reject) => {
      const request = makeRequest(
        {
          host: address.host,
          port: address.port,
          path: 'http://example.test/path',
          headers: { host: 'example.test' },
        },
        (result) => {
          let body = '';
          result.setEncoding('utf8');
          result.on('data', (chunk) => {
            body += chunk;
          });
          result.on('end', () => resolve(body));
        },
      );
      request.on('error', reject);
      request.end();
    });

    expect(response).toBe('ok');
    expect(outbound[0]).toMatchObject({ host: '198.18.2.16', family: 4, port: 80 });
  });

  it('pins HTTPS CONNECT to the validated IP without terminating TLS/SNI', async () => {
    const resolver = rebindingResolver();
    const dials: Array<{ host: string; port: number; family: 4 | 6 }> = [];
    const proxy = new ControlledNetworkProxy({ resolver, dial: fakeDial(dials, '') });
    proxies.push(proxy);
    const address = await proxy.listen();

    await rawProxyRequest(
      address.port,
      'CONNECT secure.example.test:443 HTTP/1.1\r\nHost: secure.example.test:443\r\n\r\n',
      /200 Connection Established/,
    );

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(dials).toEqual([{ host: '93.184.216.34', port: 443, family: 4 }]);
  });

  it('drops proxy-only headers when forwarding a WebSocket upgrade', async () => {
    const resolver = { resolve: vi.fn().mockResolvedValue(['93.184.216.34']) };
    const written: string[] = [];
    const proxy = new ControlledNetworkProxy({
      resolver,
      dial: recordingDial(
        written,
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      ),
    });
    proxies.push(proxy);
    const address = await proxy.listen();

    await rawProxyRequest(
      address.port,
      'GET ws://socket.example.test/chat HTTP/1.1\r\nHost: socket.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nProxy-Authorization: Basic c2VjcmV0\r\n\r\n',
      /101 Switching Protocols/,
    );

    const forwarded = written.join('');
    expect(forwarded).toMatch(/upgrade: websocket/i);
    expect(forwarded).not.toMatch(/proxy-authorization/i);
  });

  it('pins a WebSocket upgrade and preserves the original authority', async () => {
    const resolver = rebindingResolver();
    const dials: Array<{ host: string; port: number; family: 4 | 6 }> = [];
    const proxy = new ControlledNetworkProxy({
      resolver,
      dial: fakeDial(
        dials,
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      ),
    });
    proxies.push(proxy);
    const address = await proxy.listen();

    await rawProxyRequest(
      address.port,
      'GET ws://socket.example.test/chat HTTP/1.1\r\nHost: socket.example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      /101 Switching Protocols/,
    );

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(dials).toEqual([{ host: '93.184.216.34', port: 80, family: 4 }]);
  });
});
