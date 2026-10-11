import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createAdapterTestRuntime } from './fixtures/adapter-runtime';
import {
  inspectLocalAgents,
  presetConfiguration,
  resolveLocalLaunch,
} from '../src/main/agents/local-agents';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function profile() {
  const directory = await mkdtemp(join(tmpdir(), 'pilion-adapter-runtime-'));
  directories.push(directory);
  return directory;
}

it('gives the isolated app only test Node and npm links followed by system PATH directories', async () => {
  const directory = await profile();
  const runtime = await createAdapterTestRuntime(directory);
  const bin = join(directory, 'bin');
  expect(runtime.env.PATH).toBe(`${bin}:/usr/bin:/bin`);
  expect((await readdir(bin)).sort()).toEqual(['node', 'npm']);
  expect(await realpath(join(bin, 'node'))).toBe(await realpath(process.execPath));
  expect(await realpath(join(bin, 'npm'))).toBe(
    await realpath(join(dirname(process.execPath), 'npm')),
  );
  expect(await readdir(runtime.env.HOME)).toEqual([]);
  const environment = await inspectLocalAgents({
    home: runtime.env.HOME,
    env: runtime.env,
    nodePath: runtime.nodePath,
  });
  expect(environment.nodePath).toBe(runtime.nodePath);
  expect(environment.nodeVersion).toMatch(/^v\d+\./);
  expect(environment.error).toBeUndefined();
  expect(environment.agents.find((agent) => agent.id === 'claude')?.status).toBe(
    'install_required',
  );
});

it('selects fake npm beside the isolated runtime without exposing the runners bin directory', async () => {
  const directory = await profile();
  const fakeNpm = join(directory, 'fake-npm.cjs');
  const marker = join(directory, 'fake-npm-selected');
  await writeFile(
    fakeNpm,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'selected'); process.exit(1);`,
    { mode: 0o755 },
  );
  const runtime = await createAdapterTestRuntime(directory, fakeNpm);
  expect((await readdir(join(directory, 'bin'))).sort()).toEqual(['node', 'npm']);
  await mkdir(join(directory, 'cwd'));
  await expect(
    resolveLocalLaunch(
      presetConfiguration({ preset: 'claude', nodePath: runtime.nodePath }, join(directory, 'cwd')),
      {
        home: runtime.env.HOME,
        env: runtime.env,
        adaptersRoot: join(directory, 'adapters'),
      },
    ),
  ).rejects.toThrow('失败');
  expect(await readdir(directory)).toContain('fake-npm-selected');
});

it('makes the progress fake npm discoverable without falling back to a system npm', async () => {
  const directory = await profile();
  const runtime = await createAdapterTestRuntime(
    directory,
    fileURLToPath(new URL('./fixtures/e2e-npm.mjs', import.meta.url)),
  );
  const environment = await inspectLocalAgents({
    home: runtime.env.HOME,
    env: runtime.env,
    nodePath: runtime.nodePath,
    directories: [dirname(runtime.nodePath), join(directory, 'bin')],
  });
  expect(environment.agents.find((agent) => agent.id === 'claude')?.status).toBe(
    'install_required',
  );
});

it('installs the fixture adapter through fake npm while reporting growing cache bytes', async () => {
  const directory = await profile();
  const runtime = await createAdapterTestRuntime(
    directory,
    fileURLToPath(new URL('./fixtures/e2e-npm.mjs', import.meta.url)),
  );
  const adapters = join(directory, 'adapters');
  const bytes: number[] = [];
  const options = {
    home: runtime.env.HOME,
    env: runtime.env,
    nodePath: runtime.nodePath,
    directories: [dirname(runtime.nodePath), join(directory, 'bin')],
    adaptersRoot: adapters,
  };
  const launch = await resolveLocalLaunch(
    presetConfiguration({ preset: 'claude', nodePath: runtime.nodePath }, directory),
    {
      ...options,
      onInstallProgress: (state) => {
        if (state?.downloadedBytes !== undefined) bytes.push(state.downloadedBytes);
      },
    },
  );
  expect(bytes.length).toBeGreaterThan(1);
  expect(bytes.at(-1)).toBeGreaterThan(bytes[0]);
  expect(await readdir(adapters)).toEqual(['agentclientprotocol__claude-agent-acp@0.89.1']);
  expect(await readFile(launch.args![0], 'utf8')).toContain('e2e-agent.mjs');
  expect(
    (await inspectLocalAgents(options)).agents.find((agent) => agent.id === 'claude')?.status,
  ).toBe('ready');
}, 10_000);
