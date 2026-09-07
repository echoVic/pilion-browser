import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectLocalAgents,
  localSearchDirectories,
  presetConfiguration,
  resolveLocalLaunch,
} from '../src/main/agents/local-agents';
import { LocalAgentInputSchema } from '../src/shared/contracts';
import { LOCAL_AGENTS } from '../src/shared/local-agents';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'pilion-local agent-')),
  );
  directories.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const npx = join(bin, 'npx-cli.js');
  await writeFile(npx, '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(npx, join(bin, 'npx'));
  return {
    directory,
    bin,
    npx,
    options: { directories: [bin], home: directory, env: { PATH: bin } },
  };
}
describe('local ACP presets', () => {
  it('offers all six presets and uses native ACP arguments for Grok and OpenCode', async () => {
    const { bin, directory, options, npx } = await fixture();
    expect(LOCAL_AGENTS.map((agent) => agent.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'grok',
      'opencode',
      'pi',
    ]);
    for (const preset of ['grok', 'opencode', 'pi'] as const)
      expect(LocalAgentInputSchema.parse({ preset }).preset).toBe(preset);
    await writeFile(join(bin, 'grok'), '#!/bin/sh\n', { mode: 0o755 });
    const grok = presetConfiguration(
      { preset: 'grok', nodePath: '/missing/node' },
      directory,
    );
    const native = await resolveLocalLaunch(grok, options);
    expect(native.command).toBe(join(bin, 'grok'));
    expect(native.args).toEqual(['agent', '--no-leader', 'stdio']);
    const opencode = presetConfiguration({ preset: 'opencode' }, directory);
    expect((await resolveLocalLaunch(opencode, options)).args).toEqual([
      npx,
      '--yes',
      'opencode-ai@1.18.29',
      'acp',
    ]);
    await writeFile(join(bin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
    expect((await resolveLocalLaunch(opencode, options)).args).toEqual(['acp']);
  });
  it('reports missing Grok without substituting an unrelated npm package', async () => {
    const { directory, options } = await fixture();
    expect(
      (await inspectLocalAgents(options)).agents.find(
        (item) => item.id === 'grok',
      ),
    ).toMatchObject({ status: 'cli_missing' });
    await expect(
      resolveLocalLaunch(
        presetConfiguration({ preset: 'grok' }, directory),
        options,
      ),
    ).rejects.toThrow('官方 CLI');
  });
  it('uses the MCP-capable Pi adapter and ignores unrelated pi-acp binaries', async () => {
    const { directory, bin, options, npx } = await fixture();
    const packageDirectory = join(directory, 'pi-adapter');
    await mkdir(packageDirectory);
    const script = join(packageDirectory, 'index.js');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'pi-acp'));
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'pi-acp', version: '0.0.33' }),
    );
    const pi = presetConfiguration({ preset: 'pi' }, directory);
    expect((await resolveLocalLaunch(pi, options)).args).toEqual([
      npx,
      '--yes',
      '@automatalabs/pi-acp@0.6.3',
    ]);
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: '@automatalabs/pi-acp', version: '0.6.3' }),
    );
    expect((await resolveLocalLaunch(pi, options)).args).toEqual([script]);
    const oldNode = join(bin, 'old-node');
    await writeFile(oldNode, '#!/bin/sh\nprintf "v22.18.0\\n"\n', {
      mode: 0o755,
    });
    await expect(
      resolveLocalLaunch({ ...pi, nodePath: oldNode }, options),
    ).rejects.toThrow('22.19.0');
  });
  it('distinguishes ordinary CLI presence from an ACP adapter and pins the install command', async () => {
    const { bin, directory, options, npx } = await fixture();
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const environment = await inspectLocalAgents(options);
    expect(
      environment.agents.find((item) => item.id === 'claude'),
    ).toMatchObject({
      status: 'install_required',
      cliPath: join(bin, 'claude'),
    });
    const config = presetConfiguration({ preset: 'claude' }, directory);
    const launch = await resolveLocalLaunch(config, options);
    expect(launch.args).toEqual([
      npx,
      '--yes',
      '@agentclientprotocol/claude-agent-acp@0.75.1',
    ]);
    expect(launch.cwd).toBe(directory);
    expect(launch.command).toBe(environment.nodePath);
  });
  it('launches an installed JS adapter through the selected Node, preserving spaces and credentials', async () => {
    const { bin, directory, options } = await fixture();
    const script = join(directory, 'installed adapter.mjs');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'codex-acp'));
    const config = presetConfiguration(
      { preset: 'codex', nodePath: process.execPath },
      directory,
    );
    const launch = await resolveLocalLaunch(config, {
      ...options,
      env: {
        ...options.env,
        OPENAI_API_KEY: 'fixture-key',
        UNRELATED_SECRET: 'omit',
      },
    });
    expect(launch.args).toEqual([script]);
    expect(launch.env?.OPENAI_API_KEY).toBe('fixture-key');
    expect(launch.env?.UNRELATED_SECRET).toBeUndefined();
    expect(launch.env?.PATH?.split(':')[0]).toBe(dirname(launch.command));
  });
  it('recognizes legacy Claude adapter names and passes ACP mode to Gemini in installed and npx paths', async () => {
    const { bin, directory, options } = await fixture();
    await writeFile(join(bin, 'claude-code-acp'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    expect((await inspectLocalAgents(options)).agents[0].status).toBe('ready');
    const gemini = presetConfiguration({ preset: 'gemini' }, directory);
    expect((await resolveLocalLaunch(gemini, options)).args?.at(-1)).toBe(
      '--experimental-acp',
    );
    const script = join(bin, 'gemini.mjs');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'gemini'));
    expect((await resolveLocalLaunch(gemini, options)).args).toEqual([
      script,
      '--experimental-acp',
    ]);
    expect(
      (await resolveLocalLaunch(gemini, options)).env?.GEMINI_CLI_NO_RELAUNCH,
    ).toBe('1');
  });
  it('fails closed for invalid runtime paths and does not fall back to a different Node', async () => {
    const { directory, options } = await fixture();
    const environment = await inspectLocalAgents({
      ...options,
      nodePath: '/does/not/exist/node',
    });
    expect(environment.error).toContain('Node.js');
    expect(
      environment.agents
        .filter((item) => item.id !== 'grok')
        .every((item) => item.status === 'runtime_missing'),
    ).toBe(true);
    await expect(
      resolveLocalLaunch(
        presetConfiguration(
          { preset: 'codex', nodePath: '/missing/node' },
          directory,
        ),
        options,
      ),
    ).rejects.toThrow('Node.js');
    const noexec = join(directory, 'noexec');
    await writeFile(noexec, '');
    await chmod(noexec, 0o644);
    expect(
      (await inspectLocalAgents({ ...options, nodePath: noexec })).error,
    ).toBeDefined();
    expect(() =>
      LocalAgentInputSchema.parse({ preset: 'arbitrary', command: 'bad' }),
    ).toThrow();
  });
  it('discovers nvm without relying on a shell startup file', async () => {
    const { directory } = await fixture();
    const nvm = join(directory, '.nvm/versions/node/v22.23.1/bin');
    await mkdir(nvm, { recursive: true });
    expect(await localSearchDirectories(directory, { PATH: '' })).toContain(
      nvm,
    );
  });
});
