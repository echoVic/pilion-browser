import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkStatus } from '../src/main/external/cli/status.js';
import { handshake } from '../src/main/external/client.js';

let dir: string;
let server: Server | undefined;

/** 一个只回握手应答的假 Pilion：旧版回 `{}`，新版回 `{"version"}`。 */
async function fakePilion(ack: string): Promise<string> {
  const socketPath = join(dir, 's.sock');
  server = createServer((socket) => {
    socket.once('data', () => socket.write(`${ack}\n`));
  });
  await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  return socketPath;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pcs-'));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('handshake against an old Pilion that acks {}', () => {
  it('still resolves, with no version', async () => {
    const socketPath = await fakePilion('{}');
    expect(await handshake({ socketPath, token: 'pct_x' })).toEqual({});
  });

  it('pilion status passes and reports the version as 旧版未上报', async () => {
    const socketPath = await fakePilion('{}');
    const tokenFile = join(dir, 'cli.token');
    await writeFile(tokenFile, 'pct_x\n');
    const report = await checkStatus('1.2.3', {
      PILION_EXTERNAL_SOCKET: socketPath,
      PILION_EXTERNAL_TOKEN_FILE: tokenFile,
    });
    expect(report.every((line) => line.ok)).toBe(true);
    expect(report.find((line) => line.item === 'version')).toEqual({
      item: 'version',
      ok: true,
      detail: 'Pilion (旧版未上报)',
    });
  });

  it('pilion status flags a version mismatch reported by a new Pilion', async () => {
    const socketPath = await fakePilion('{"version":"2.0.0"}');
    const report = await checkStatus('1.2.3', {
      PILION_EXTERNAL_SOCKET: socketPath,
      PILION_EXTERNAL_TOKEN: 'pct_x',
    });
    expect(report.find((line) => line.item === 'version')?.ok).toBe(false);
  });

  it('pilion status reports a missing credential with the install hint', async () => {
    const socketPath = await fakePilion('{}');
    const report = await checkStatus('1.2.3', {
      PILION_EXTERNAL_SOCKET: socketPath,
      PILION_EXTERNAL_TOKEN_FILE: join(dir, 'absent.token'),
    });
    expect(report.find((line) => line.item === 'credential')).toMatchObject({ ok: false });
    expect(report.some((line) => line.item === 'handshake')).toBe(false);
  });
});

describe('resolveEndpoint missing-credential message', () => {
  it('points at 安装到 Agent', async () => {
    const { resolveEndpoint } = await import('../src/main/external/client.js');
    await expect(resolveEndpoint({})).rejects.toThrow(/安装到 Agent/);
  });
});
