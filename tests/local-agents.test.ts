import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortAdapterInstalls,
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
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
/** 照真实 npm 的目录结构「安装」：包、它的 bin 入口和 .bin 链接，并记下每次调用的参数。 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
const name = spec.slice(0, spec.lastIndexOf('@'));
const version = spec.slice(spec.lastIndexOf('@') + 1);
const bins = {
  '@agentclientprotocol/claude-agent-acp': 'claude-agent-acp',
  '@agentclientprotocol/codex-acp': 'codex-acp',
  '@google/gemini-cli': 'gemini',
  'opencode-ai': 'opencode',
  '@automatalabs/pi-acp': 'pi-acp',
  'blade-code': 'blade',
};
const root = path.join(prefix, 'node_modules', name);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version, bin: { [bins[name]]: 'cli.js' } }));
fs.writeFileSync(path.join(root, 'cli.js'), '#!/usr/bin/env node\\n', { mode: 0o755 });
fs.mkdirSync(path.join(prefix, 'node_modules', '.bin'), { recursive: true });
fs.symlinkSync(path.join('..', name, 'cli.js'), path.join(prefix, 'node_modules', '.bin', bins[name]));
fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ dependencies: { [name]: version } }));
fs.appendFileSync(path.join(path.dirname(prefix), 'npm-calls.log'), JSON.stringify(args) + '\\n');
`;
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pilion-local agent-')));
  directories.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const npx = join(bin, 'npx-cli.js');
  await writeFile(npx, '#!/usr/bin/env node\n', { mode: 0o755 });
  await symlink(npx, join(bin, 'npx'));
  const npmCli = join(bin, 'npm-cli.js');
  await writeFile(npmCli, FAKE_NPM, { mode: 0o755 });
  await symlink(npmCli, join(bin, 'npm'));
  const adapters = join(directory, 'adapters');
  return {
    directory,
    bin,
    npx,
    npmCli,
    adapters,
    options: { directories: [bin], home: directory, env: { PATH: bin }, adaptersRoot: adapters },
  };
}
/** Pilion 装好的适配器入口：adapters/<去掉 @ 的包名，/ 换成 __>@<版本>/node_modules/<包名>/cli.js。 */
function installedScript(adapters: string, name: string, version: string): string {
  const folder = `${name.replace(/^@/, '').replace(/\//g, '__')}@${version}`;
  return join(adapters, folder, 'node_modules', name, 'cli.js');
}
async function npmCalls(adapters: string): Promise<string[][]> {
  try {
    return (await readFile(join(adapters, 'npm-calls.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}
describe('local ACP presets', () => {
  it('offers all eight presets and uses native ACP arguments for Grok, OpenCode, Orca and Blade', async () => {
    const { bin, directory, options, adapters } = await fixture();
    expect(LOCAL_AGENTS.map((agent) => agent.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'grok',
      'opencode',
      'pi',
      'orca',
      'blade',
    ]);
    for (const preset of ['grok', 'opencode', 'pi', 'orca', 'blade'] as const)
      expect(LocalAgentInputSchema.parse({ preset }).preset).toBe(preset);
    await writeFile(join(bin, 'grok'), '#!/bin/sh\n', { mode: 0o755 });
    const grok = presetConfiguration({ preset: 'grok', nodePath: '/missing/node' }, directory);
    const native = await resolveLocalLaunch(grok, options);
    expect(native.command).toBe(join(bin, 'grok'));
    expect(native.args).toEqual(['agent', '--no-leader', 'stdio']);
    const opencode = presetConfiguration({ preset: 'opencode' }, directory);
    expect((await resolveLocalLaunch(opencode, options)).args).toEqual([
      installedScript(adapters, 'opencode-ai', '1.18.29'),
      'acp',
    ]);
    await writeFile(join(bin, 'orca'), '#!/bin/sh\n', { mode: 0o755 });
    const orca = presetConfiguration({ preset: 'orca', nodePath: '/missing/node' }, directory);
    const orcaLaunch = await resolveLocalLaunch(orca, options);
    expect(orcaLaunch.command).toBe(join(bin, 'orca'));
    expect(orcaLaunch.args).toEqual(['--mode=acp']);
    const blade = presetConfiguration({ preset: 'blade' }, directory);
    expect((await resolveLocalLaunch(blade, options)).args).toEqual([
      installedScript(adapters, 'blade-code', '0.10.205'),
      '--acp',
    ]);
    await writeFile(join(bin, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
    expect((await resolveLocalLaunch(opencode, options)).args).toEqual(['acp']);
  });
  it('reports missing Grok without substituting an unrelated npm package', async () => {
    const { directory, options } = await fixture();
    expect(
      (await inspectLocalAgents(options)).agents.find((item) => item.id === 'grok'),
    ).toMatchObject({ status: 'cli_missing' });
    await expect(
      resolveLocalLaunch(presetConfiguration({ preset: 'grok' }, directory), options),
    ).rejects.toThrow('官方 CLI');
  });
  it('uses the MCP-capable Pi adapter and ignores unrelated pi-acp binaries', async () => {
    const { directory, bin, options, adapters } = await fixture();
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
      installedScript(adapters, '@automatalabs/pi-acp', '0.6.3'),
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
    await expect(resolveLocalLaunch({ ...pi, nodePath: oldNode }, options)).rejects.toThrow(
      '22.19.0',
    );
  });
  it('treats an adapter with an unfinished dependency tree as needing a reinstall', async () => {
    const { bin, directory, options, adapters } = await fixture();
    const packageDirectory = join(
      directory,
      'node_modules',
      '@agentclientprotocol',
      'claude-agent-acp',
    );
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@agentclientprotocol/claude-agent-acp',
        version: '0.89.1',
        dependencies: { '@anthropic-ai/claude-agent-sdk': '0.3.257' },
      }),
    );
    const script = join(packageDirectory, 'index.js');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'claude-agent-acp'));

    const environment = await inspectLocalAgents(options);
    expect(environment.agents.find((item) => item.id === 'claude')).toMatchObject({
      status: 'install_required',
    });
    const launch = await resolveLocalLaunch(
      presetConfiguration({ preset: 'claude' }, directory),
      options,
    );
    expect(launch.args).toEqual([
      installedScript(adapters, '@agentclientprotocol/claude-agent-acp', '0.89.1'),
    ]);
  });

  it('distinguishes ordinary CLI presence from an ACP adapter and pins the install command', async () => {
    const { bin, directory, options, adapters } = await fixture();
    await writeFile(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const environment = await inspectLocalAgents(options);
    expect(environment.agents.find((item) => item.id === 'claude')).toMatchObject({
      status: 'install_required',
      cliPath: join(bin, 'claude'),
    });
    const config = presetConfiguration({ preset: 'claude' }, directory);
    const launch = await resolveLocalLaunch(config, options);
    expect(launch.args).toEqual([
      installedScript(adapters, '@agentclientprotocol/claude-agent-acp', '0.89.1'),
    ]);
    expect((await npmCalls(adapters))[0]).toEqual(
      expect.arrayContaining(['install', '@agentclientprotocol/claude-agent-acp@0.89.1']),
    );
    expect(launch.cwd).toBe(directory);
    expect(launch.command).toBe(environment.nodePath);
  });
  it('launches an installed JS adapter through the selected Node, preserving spaces and credentials', async () => {
    const { bin, directory, options } = await fixture();
    const script = join(directory, 'installed adapter.mjs');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'codex-acp'));
    const config = presetConfiguration({ preset: 'codex', nodePath: process.execPath }, directory);
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
  it('recognizes legacy Claude adapter names and passes ACP mode to Gemini whether found or installed', async () => {
    const { bin, directory, options } = await fixture();
    await writeFile(join(bin, 'claude-code-acp'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    expect((await inspectLocalAgents(options)).agents[0].status).toBe('ready');
    const gemini = presetConfiguration({ preset: 'gemini' }, directory);
    expect((await resolveLocalLaunch(gemini, options)).args?.at(-1)).toBe('--experimental-acp');
    const script = join(bin, 'gemini.mjs');
    await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o755 });
    await symlink(script, join(bin, 'gemini'));
    expect((await resolveLocalLaunch(gemini, options)).args).toEqual([
      script,
      '--experimental-acp',
    ]);
    expect((await resolveLocalLaunch(gemini, options)).env?.GEMINI_CLI_NO_RELAUNCH).toBe('1');
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
        presetConfiguration({ preset: 'codex', nodePath: '/missing/node' }, directory),
        options,
      ),
    ).rejects.toThrow('Node.js');
    const noexec = join(directory, 'noexec');
    await writeFile(noexec, '');
    await chmod(noexec, 0o644);
    expect((await inspectLocalAgents({ ...options, nodePath: noexec })).error).toBeDefined();
    expect(() => LocalAgentInputSchema.parse({ preset: 'arbitrary', command: 'bad' })).toThrow();
  });
  it('discovers nvm without relying on a shell startup file', async () => {
    const { directory } = await fixture();
    const nvm = join(directory, '.nvm/versions/node/v22.23.1/bin');
    await mkdir(nvm, { recursive: true });
    expect(await localSearchDirectories(directory, { PATH: '' })).toContain(nvm);
  });
});

describe('installing a missing adapter', () => {
  const claude = '@agentclientprotocol/claude-agent-acp';

  it('installs into its own directory before launching, never through npx, and only once', async () => {
    const { directory, adapters, options } = await fixture();
    const config = presetConfiguration({ preset: 'claude' }, directory);
    const announced: string[] = [];
    const launch = await resolveLocalLaunch(config, {
      ...options,
      onInstall: (preset) => announced.push(preset.id),
    });
    expect(announced).toEqual(['claude']);
    expect(launch.command).toBe(await realpath(process.execPath));
    expect(launch.args).toEqual([installedScript(adapters, claude, '0.89.1')]);
    expect((await readdir(adapters)).sort()).toEqual([
      'agentclientprotocol__claude-agent-acp@0.89.1',
      'npm-calls.log',
    ]);
    expect(
      (await inspectLocalAgents(options)).agents.find((item) => item.id === 'claude'),
    ).toMatchObject({
      status: 'ready',
      executablePath: installedScript(adapters, claude, '0.89.1'),
    });
    await resolveLocalLaunch(config, options);
    expect(await npmCalls(adapters)).toHaveLength(1);
  });

  it("reports npm's output when the install fails and leaves nothing that looks installed", async () => {
    const { directory, adapters, options, npmCli } = await fixture();
    await writeFile(
      npmCli,
      '#!/usr/bin/env node\nprocess.stderr.write("npm error code ETIMEDOUT\\nnpm error network request to the registry failed\\n");\nprocess.exit(1);\n',
      { mode: 0o755 },
    );
    await expect(
      resolveLocalLaunch(presetConfiguration({ preset: 'claude' }, directory), options),
    ).rejects.toThrow('npm error network request to the registry failed');
    expect(await readdir(adapters)).toEqual([]);
    expect(
      (await inspectLocalAgents(options)).agents.find((item) => item.id === 'claude'),
    ).toMatchObject({ status: 'install_required' });
  });

  it('stops an install that outlives its time limit, even one ignoring SIGTERM, and leaves nothing behind', async () => {
    const { directory, adapters, options, npmCli } = await fixture();
    // 像慢网下载大包时的 npm：已经解压了一部分，收到 SIGTERM 也不退。
    await writeFile(
      npmCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
fs.mkdirSync(path.join(prefix, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'), { recursive: true });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    await expect(
      resolveLocalLaunch(presetConfiguration({ preset: 'claude' }, directory), {
        ...options,
        installTimeoutMs: 500,
      }),
    ).rejects.toThrow('超时');
    expect(await readdir(adapters)).toEqual([]);
  });

  it('stops a running install when Pilion shuts down instead of leaving npm downloading', async () => {
    const { directory, adapters, options, npmCli } = await fixture();
    await writeFile(
      npmCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
fs.writeFileSync(path.join(path.dirname(path.dirname(prefix)), 'npm.pid'), String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const launching = resolveLocalLaunch(
      presetConfiguration({ preset: 'claude' }, directory),
      options,
    );
    const pid = await vi.waitFor(async () =>
      Number(await readFile(join(directory, 'npm.pid'), 'utf8')),
    );
    abortAdapterInstalls();
    await expect(launching).rejects.toThrow('已取消');
    expect(await readdir(adapters)).toEqual([]);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('ignores a half-written npx cache entry and installs into its own directory instead', async () => {
    const { directory, adapters, options, bin } = await fixture();
    // npx 被打断后留下的样子：有 node_modules，没有 package.json，也没有 .bin。
    const broken = join(directory, '.npm', '_npx', '8f1da047bc7d654e', 'node_modules', claude);
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, 'package.json'),
      JSON.stringify({ name: claude, version: '0.89.1' }),
    );
    // 不传 directories 时才会去查 npx 缓存。这时 npm 要到选定的 Node 旁边去找：用一个转调真实 Node
    // 的脚本当选定的 Node，免得解析到本机 nvm 里真正的 npm、真的去下载。
    const node = join(bin, 'node-wrapper');
    await writeFile(node, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const withCache = {
      home: options.home,
      env: options.env,
      adaptersRoot: options.adaptersRoot,
      nodePath: node,
    };
    expect(
      (await inspectLocalAgents(withCache)).agents.find((item) => item.id === 'claude'),
    ).toMatchObject({ status: 'install_required' });
    const launch = await resolveLocalLaunch(
      presetConfiguration({ preset: 'claude' }, directory),
      withCache,
    );
    expect(launch.args).toEqual([installedScript(adapters, claude, '0.89.1')]);
  });

  it('clears a staging directory left by an interrupted install before installing again', async () => {
    const { directory, adapters, options } = await fixture();
    const stale = join(
      adapters,
      'agentclientprotocol__claude-agent-acp@0.89.1.installing-interrupted',
    );
    await mkdir(join(stale, 'node_modules', claude), { recursive: true });
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(stale, hourAgo, hourAgo);
    expect(
      (await inspectLocalAgents(options)).agents.find((item) => item.id === 'claude'),
    ).toMatchObject({ status: 'install_required' });
    await resolveLocalLaunch(presetConfiguration({ preset: 'claude' }, directory), options);
    expect((await readdir(adapters)).sort()).toEqual([
      'agentclientprotocol__claude-agent-acp@0.89.1',
      'npm-calls.log',
    ]);
  });

  it('shares one install between connects that start at the same time', async () => {
    const { directory, adapters, options } = await fixture();
    const config = presetConfiguration({ preset: 'claude' }, directory);
    const [first, second] = await Promise.all([
      resolveLocalLaunch(config, options),
      resolveLocalLaunch(config, options),
    ]);
    expect(first.args).toEqual(second.args);
    expect(await npmCalls(adapters)).toHaveLength(1);
  });
});
