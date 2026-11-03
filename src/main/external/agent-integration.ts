import { randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

/**
 * 「安装到 Agent」：给本机终端 Agent 零配置接上 Pilion。
 * 负责四样本机文件，全部带「是我们写的」标记，绝不覆盖/删除没有标记的同名文件，任何写入点拒绝符号链接：
 *  - <externalDir>/cli.token（0600）：集成客户端的明文 token；
 *  - <home>/.local/bin/pilion（0755）：含 SHIM_MARKER 的 sh 包装脚本；
 *  - <home>/<agent>/skills/pilion-browser/：skill 拷贝，内含 MANAGED_FILE（写版本号）；
 *  - <externalDir>/integration.json（0600）：安装状态。
 * 签发客户端由调用方注入（主进程持有 ExternalControlServer），本模块只做文件系统。
 */

export const SHIM_MARKER = '# pilion-shim v1';
export const MANAGED_FILE = '.pilion-managed';
export const SKILL_NAME = 'pilion-browser';
const TOKEN_FILE = 'cli.token';
const STATE_FILE = 'integration.json';

export const AGENT_SKILL_DIRS: ReadonlyArray<{ agent: string; dir: string }> = [
  { agent: 'Claude Code', dir: '.claude/skills' },
  { agent: 'Codex', dir: '.codex/skills' },
  { agent: 'Agents（通用）', dir: '.agents/skills' },
  { agent: 'Gemini CLI', dir: '.gemini/skills' },
  { agent: 'Trae', dir: '.trae/skills' },
  { agent: 'Cursor', dir: '.cursor/skills' },
];

export interface IntegrationPaths {
  home: string;
  externalDir: string;
  socketPath: string;
  executable: string;
  cliScript: string;
  skillSource: string;
  version: string;
}
export interface IntegrationTarget {
  agent: string;
  path: string;
  status: 'installed' | 'skipped-foreign';
}
export interface IntegrationState {
  version: 1;
  clientId: string;
  installedAt: string;
  appVersion: string;
  shimPath: string;
  targets: IntegrationTarget[];
}
export interface IntegrationStatus {
  installed: boolean;
  clientId?: string;
  installedAt?: string;
  shimPath: string;
  shimConflict: boolean;
  pathHasShimDir: boolean;
  targets: IntegrationTarget[];
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderShim(paths: IntegrationPaths): string {
  return [
    '#!/bin/sh',
    `${SHIM_MARKER} — 由 Pilion 生成，每次启动会重写；手动修改会被覆盖`,
    `: "\${PILION_EXTERNAL_SOCKET:=$(printf %s "${escapeDq(paths.socketPath)}")}"`,
    `: "\${PILION_EXTERNAL_TOKEN_FILE:=$(printf %s "${escapeDq(join(paths.externalDir, TOKEN_FILE))}")}"`,
    'export PILION_EXTERNAL_SOCKET PILION_EXTERNAL_TOKEN_FILE',
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(paths.executable)} ${shellQuote(paths.cliScript)} "$@"`,
    '',
  ].join('\n');
}

/** 默认值出现在双引号参数展开里：转义 " $ ` \ 四个字符即可。 */
function escapeDq(value: string): string {
  return value.replace(/["$`\\]/g, (c) => `\\${c}`);
}

type Entry = 'missing' | 'symlink' | 'file' | 'dir';
async function entry(path: string): Promise<Entry> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return 'symlink';
  return info.isDirectory() ? 'dir' : 'file';
}

async function isOurShim(path: string): Promise<boolean> {
  if ((await entry(path)) !== 'file') return false;
  return (await readFile(path, 'utf8')).split('\n')[1]?.startsWith(SHIM_MARKER) ?? false;
}

async function managedVersion(dir: string): Promise<string | undefined> {
  if ((await entry(dir)) !== 'dir') return undefined;
  const marker = join(dir, MANAGED_FILE);
  if ((await entry(marker)) !== 'file') return undefined;
  return (await readFile(marker, 'utf8')).trim();
}

/** 原子写：同目录临时文件 → chmod → rename。目标若是符号链接，rename 会替换链接本身而不跟随，但我们先行拒绝。 */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode, flag: 'wx' });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export class AgentIntegration {
  constructor(
    private readonly paths: IntegrationPaths,
    private readonly env: { PATH?: string } = process.env,
  ) {}

  private get shimPath(): string {
    return join(this.paths.home, '.local', 'bin', 'pilion');
  }
  private get tokenPath(): string {
    return join(this.paths.externalDir, TOKEN_FILE);
  }
  private get statePath(): string {
    return join(this.paths.externalDir, STATE_FILE);
  }

  async readState(): Promise<IntegrationState | undefined> {
    if ((await entry(this.statePath)) !== 'file') return undefined;
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as IntegrationState;
      return parsed?.version === 1 && typeof parsed.clientId === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async candidates(): Promise<IntegrationTarget[]> {
    const out: IntegrationTarget[] = [];
    for (const { agent, dir } of AGENT_SKILL_DIRS) {
      const parent = join(this.paths.home, dir);
      if ((await entry(parent)) !== 'dir') continue;
      const path = join(parent, SKILL_NAME);
      const kind = await entry(path);
      const foreign = kind !== 'missing' && (await managedVersion(path)) === undefined;
      out.push({ agent, path, status: foreign ? 'skipped-foreign' : 'installed' });
    }
    return out;
  }

  async status(): Promise<IntegrationStatus> {
    const state = await this.readState();
    const shimKind = await entry(this.shimPath);
    const shimConflict = shimKind !== 'missing' && !(await isOurShim(this.shimPath));
    const shimDir = dirname(this.shimPath);
    const pathHasShimDir = (this.env.PATH ?? '').split(delimiter).includes(shimDir);
    return {
      installed: Boolean(state),
      ...(state ? { clientId: state.clientId, installedAt: state.installedAt } : {}),
      shimPath: this.shimPath,
      shimConflict,
      pathHasShimDir,
      targets: state?.targets ?? (await this.candidates()),
    };
  }

  /** 先做完所有「会拒绝」的检查，再签发客户端，避免拒绝时留下一个没用的 token。 */
  async install(
    issue: () => Promise<{ clientId: string; token: string }>,
  ): Promise<IntegrationState> {
    const shimKind = await entry(this.shimPath);
    if (shimKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.shimPath}`);
    if (shimKind !== 'missing' && !(await isOurShim(this.shimPath)))
      throw new Error(`已存在不是 Pilion 生成的 ${this.shimPath}，请先移走它再安装 pilion 命令`);
    const tokenKind = await entry(this.tokenPath);
    if (tokenKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.tokenPath}`);
    if ((await entry(this.statePath)) === 'symlink')
      throw new Error(`拒绝写入符号链接：${this.statePath}`);

    const { clientId, token } = await issue();

    await mkdir(this.paths.externalDir, { recursive: true, mode: 0o700 });
    if (tokenKind === 'file') await unlink(this.tokenPath);
    await writeFile(this.tokenPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(this.tokenPath, 0o600);

    await writeAtomic(this.shimPath, renderShim(this.paths), 0o755);
    const targets = await this.copySkills(true);

    const state: IntegrationState = {
      version: 1,
      clientId,
      installedAt: new Date().toISOString(),
      appVersion: this.paths.version,
      shimPath: this.shimPath,
      targets,
    };
    await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    return state;
  }

  async reconcile(): Promise<void> {
    const state = await this.readState();
    if (!state) return;
    const expected = renderShim(this.paths);
    const shimKind = await entry(this.shimPath);
    if (
      shimKind === 'missing' ||
      ((await isOurShim(this.shimPath)) && (await readFile(this.shimPath, 'utf8')) !== expected)
    )
      await writeAtomic(this.shimPath, expected, 0o755);
    const targets = await this.copySkills(false);
    if (
      state.appVersion !== this.paths.version ||
      JSON.stringify(targets) !== JSON.stringify(state.targets)
    )
      await writeAtomic(
        this.statePath,
        `${JSON.stringify({ ...state, appVersion: this.paths.version, targets }, null, 2)}\n`,
        0o600,
      );
  }

  async remove(): Promise<string | undefined> {
    const state = await this.readState();
    if ((await entry(this.tokenPath)) === 'file') await unlink(this.tokenPath);
    if (await isOurShim(this.shimPath)) await unlink(this.shimPath);
    for (const { dir } of AGENT_SKILL_DIRS) {
      const path = join(this.paths.home, dir, SKILL_NAME);
      if ((await managedVersion(path)) !== undefined)
        await rm(path, { recursive: true, force: true });
    }
    if ((await entry(this.statePath)) === 'file') await unlink(this.statePath);
    return state?.clientId;
  }

  /** force=true（安装）：重写所有我们管的拷贝；false（启动对账）：只刷新版本落后的。 */
  private async copySkills(force: boolean): Promise<IntegrationTarget[]> {
    const targets = await this.candidates();
    for (const target of targets) {
      if (target.status !== 'installed') continue;
      const current = await managedVersion(target.path);
      if (!force && current === this.paths.version) continue;
      const tmp = `${target.path}.${randomBytes(4).toString('hex')}.tmp`;
      await cp(this.paths.skillSource, tmp, { recursive: true, dereference: true });
      await writeFile(join(tmp, MANAGED_FILE), `${this.paths.version}\n`);
      await rm(target.path, { recursive: true, force: true });
      await rename(tmp, target.path);
    }
    return targets;
  }
}
