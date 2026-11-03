import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentIntegration,
  MANAGED_FILE,
  SHIM_MARKER,
  renderShim,
  shellQuote,
  type IntegrationPaths,
} from '../src/main/external/agent-integration.js';

const run = promisify(execFile);

let root: string;
let paths: IntegrationPaths;

async function makeSkillSource(dir: string, version: string) {
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: pilion-browser\nmetadata:\n  version: "${version}"\n---\nbody\n`,
  );
  await writeFile(join(dir, 'references', 'install.md'), 'install');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pilion int'eg "));
  const home = join(root, 'home');
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await mkdir(join(home, '.codex', 'skills'), { recursive: true });
  const skillSource = join(root, 'app', 'skills', 'pilion-browser');
  await makeSkillSource(skillSource, '1.0.0');
  paths = {
    home,
    externalDir: join(root, 'user data', 'external'),
    socketPath: join(root, 'user data', 'external', 'external.sock'),
    executable: join(root, 'app', 'Pilion'),
    cliScript: join(root, 'app', 'dist', 'main', 'main', 'external', 'pilion-cli.js'),
    skillSource,
    version: '1.0.0',
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const issue =
  (clientId = 'cid1') =>
  async () => ({ clientId, token: `pct_${clientId}_secret` });

describe('shellQuote / renderShim', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote("a b'c")).toBe(`'a b'\\''c'`);
  });

  it('renders a marked POSIX shim that defaults the socket and token file', () => {
    const shim = renderShim(paths);
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true);
    expect(shim).toContain(SHIM_MARKER);
    expect(shim).toContain(`: "\${PILION_EXTERNAL_SOCKET:=`);
    expect(shim).toContain(`: "\${PILION_EXTERNAL_TOKEN_FILE:=`);
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1 exec');
    expect(shim).toContain('"$@"');
  });

  it('the shim runs and forwards env and args (paths with spaces and quotes)', async () => {
    // 用一个假的「可执行文件」打印它收到的环境和参数，验证 shim 的转义和默认值。
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(
      paths.executable,
      '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$PILION_EXTERNAL_SOCKET" "$PILION_EXTERNAL_TOKEN_FILE" "$@"\n',
      { mode: 0o755 },
    );
    const shimFile = join(root, 'shim.sh');
    await writeFile(shimFile, renderShim(paths), { mode: 0o755 });
    const { stdout } = await run(shimFile, ['tabs', '--json'], { env: { PATH: '/usr/bin:/bin' } });
    expect(stdout.split('\n').slice(0, 6)).toEqual([
      '1',
      paths.socketPath,
      join(paths.externalDir, 'cli.token'),
      paths.cliScript,
      'tabs',
      '--json',
    ]);
    const overridden = await run(shimFile, [], {
      env: { PATH: '/usr/bin:/bin', PILION_EXTERNAL_SOCKET: '/x.sock' },
    });
    expect(overridden.stdout.split('\n')[1]).toBe('/x.sock');
  });
});

describe('install', () => {
  it('writes token 0600, shim 0755, copies the skill only into existing agent dirs, and records state', async () => {
    const integration = new AgentIntegration(paths, { PATH: '/usr/bin' });
    const state = await integration.install(issue());
    const token = join(paths.externalDir, 'cli.token');
    expect(await readFile(token, 'utf8')).toBe('pct_cid1_secret\n');
    expect((await stat(token)).mode & 0o777).toBe(0o600);
    const shim = join(paths.home, '.local', 'bin', 'pilion');
    expect((await stat(shim)).mode & 0o777).toBe(0o755);
    expect(await readFile(shim, 'utf8')).toBe(renderShim(paths));
    for (const agent of ['.claude', '.codex']) {
      const target = join(paths.home, agent, 'skills', 'pilion-browser');
      expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('name: pilion-browser');
      expect(await readFile(join(target, 'references', 'install.md'), 'utf8')).toBe('install');
      expect(await readFile(join(target, MANAGED_FILE), 'utf8')).toBe('1.0.0\n');
    }
    await expect(lstat(join(paths.home, '.gemini'))).rejects.toThrow();
    expect(state.clientId).toBe('cid1');
    expect(state.targets.map((t) => [t.agent, t.status])).toEqual([
      ['Claude Code', 'installed'],
      ['Codex', 'installed'],
    ]);
    const saved = JSON.parse(await readFile(join(paths.externalDir, 'integration.json'), 'utf8'));
    expect(saved).toMatchObject({ version: 1, clientId: 'cid1', appVersion: '1.0.0' });
    expect((await stat(join(paths.externalDir, 'integration.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite a foreign ~/.local/bin/pilion and issues no client', async () => {
    await mkdir(join(paths.home, '.local', 'bin'), { recursive: true });
    await writeFile(join(paths.home, '.local', 'bin', 'pilion'), '#!/bin/sh\necho mine\n');
    let issued = false;
    await expect(
      new AgentIntegration(paths).install(async () => {
        issued = true;
        return { clientId: 'x', token: 't' };
      }),
    ).rejects.toThrow(/已存在.*pilion/);
    expect(issued).toBe(false);
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toContain('mine');
  });

  it('refuses a symlinked shim path or token path', async () => {
    await mkdir(join(paths.home, '.local', 'bin'), { recursive: true });
    await writeFile(join(root, 'elsewhere'), 'x');
    await symlink(join(root, 'elsewhere'), join(paths.home, '.local', 'bin', 'pilion'));
    await expect(new AgentIntegration(paths).install(issue())).rejects.toThrow(/符号链接/);

    await rm(join(paths.home, '.local', 'bin', 'pilion'));
    await mkdir(paths.externalDir, { recursive: true });
    await symlink(join(root, 'elsewhere'), join(paths.externalDir, 'cli.token'));
    await expect(new AgentIntegration(paths).install(issue())).rejects.toThrow(/符号链接/);
    expect(await readFile(join(root, 'elsewhere'), 'utf8')).toBe('x');
  });

  it('skips a foreign skill dir with the same name and reports it', async () => {
    const foreign = join(paths.home, '.claude', 'skills', 'pilion-browser');
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'SKILL.md'), 'user-owned');
    const state = await new AgentIntegration(paths).install(issue());
    expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('user-owned');
    expect(state.targets.find((t) => t.agent === 'Claude Code')?.status).toBe('skipped-foreign');
  });

  it('re-install replaces our own token, shim and copies', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue('cid1'));
    await integration.install(issue('cid2'));
    expect(await readFile(join(paths.externalDir, 'cli.token'), 'utf8')).toBe('pct_cid2_secret\n');
    expect((await integration.readState())?.clientId).toBe('cid2');
  });
});

describe('reconcile', () => {
  it('does nothing when not installed', async () => {
    await new AgentIntegration(paths).reconcile();
    await expect(lstat(join(paths.home, '.local', 'bin', 'pilion'))).rejects.toThrow();
  });

  it('rewrites a stale shim and refreshes outdated managed copies only', async () => {
    const first = new AgentIntegration(paths);
    await first.install(issue());
    // App 升级并移动：版本与可执行路径变了。
    await makeSkillSource(paths.skillSource, '2.0.0');
    const moved = { ...paths, executable: join(root, 'moved', 'Pilion'), version: '2.0.0' };
    // 用户自己在 codex 下放了同名 skill（无标记）——不应被动。
    const codex = join(paths.home, '.codex', 'skills', 'pilion-browser');
    await rm(codex, { recursive: true });
    await mkdir(codex);
    await writeFile(join(codex, 'SKILL.md'), 'user-owned');
    await new AgentIntegration(moved).reconcile();
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toBe(
      renderShim(moved),
    );
    const claude = join(paths.home, '.claude', 'skills', 'pilion-browser');
    expect(await readFile(join(claude, MANAGED_FILE), 'utf8')).toBe('2.0.0\n');
    expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toContain('2.0.0');
    expect(await readFile(join(codex, 'SKILL.md'), 'utf8')).toBe('user-owned');
  });

  it('leaves a shim that the user replaced alone', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue());
    await writeFile(join(paths.home, '.local', 'bin', 'pilion'), '#!/bin/sh\necho mine\n');
    await integration.reconcile();
    expect(await readFile(join(paths.home, '.local', 'bin', 'pilion'), 'utf8')).toContain('mine');
  });
});

describe('remove', () => {
  it('deletes token, our shim, our copies and state; keeps foreign files', async () => {
    const integration = new AgentIntegration(paths);
    await integration.install(issue());
    const foreignGemini = join(paths.home, '.gemini', 'skills', 'pilion-browser');
    await mkdir(foreignGemini, { recursive: true });
    await writeFile(join(foreignGemini, 'SKILL.md'), 'user-owned');
    expect(await integration.remove()).toBe('cid1');
    await expect(lstat(join(paths.externalDir, 'cli.token'))).rejects.toThrow();
    await expect(lstat(join(paths.home, '.local', 'bin', 'pilion'))).rejects.toThrow();
    await expect(lstat(join(paths.home, '.claude', 'skills', 'pilion-browser'))).rejects.toThrow();
    await expect(lstat(join(paths.externalDir, 'integration.json'))).rejects.toThrow();
    expect(await readFile(join(foreignGemini, 'SKILL.md'), 'utf8')).toBe('user-owned');
    expect(await integration.remove()).toBeUndefined();
  });
});

describe('status', () => {
  it('reports candidates, PATH and conflicts before install', async () => {
    const s = await new AgentIntegration(paths, {
      PATH: `/usr/bin:${join(paths.home, '.local', 'bin')}`,
    }).status();
    expect(s).toMatchObject({ installed: false, shimConflict: false, pathHasShimDir: true });
    expect(s.targets.map((t) => t.agent)).toEqual(['Claude Code', 'Codex']);
  });
});

it('refuses a symlinked state path and issues no client', async () => {
  await mkdir(paths.externalDir, { recursive: true });
  await writeFile(join(root, 'elsewhere'), 'x');
  await symlink(join(root, 'elsewhere'), join(paths.externalDir, 'integration.json'));
  let issued = false;
  await expect(
    new AgentIntegration(paths).install(async () => {
      issued = true;
      return { clientId: 'x', token: 't' };
    }),
  ).rejects.toThrow(/符号链接/);
  expect(issued).toBe(false);
  expect(await readFile(join(root, 'elsewhere'), 'utf8')).toBe('x');
});
