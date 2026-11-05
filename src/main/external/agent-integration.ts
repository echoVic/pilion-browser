import { randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { compareSkillVersions, readSkillVersion } from './agent-skill-package.js';

/**
 * 「安装到 Agent」：给本机终端 Agent 零配置接上 Pilion。
 * 负责四样本机文件，全部带「是我们写的」标记，绝不覆盖/删除没有标记的同名文件，任何写入点拒绝符号链接：
 *  - <externalDir>/cli.token（0600）：集成客户端的明文 token；
 *  - <home>/.local/bin/pilion（0755）：含 SHIM_MARKER 的 sh 包装脚本；
 *  - <home>/<agent>/skills/pilion-browser/：skill 拷贝，内含 MANAGED_FILE（所有权标记和独立 skill 版本）；
 *  - <externalDir>/integration.json（0600）：安装状态。
 * 签发客户端由调用方注入（主进程持有 ExternalControlServer），本模块只做文件系统。
 */

export const SHIM_MARKER = '# pilion-shim v1';
export const MANAGED_FILE = '.pilion-managed';
export const SKILL_NAME = 'pilion-browser';
const TOKEN_FILE = 'cli.token';
const STATE_FILE = 'integration.json';

/**
 * 相对 home 的 skills 目录；candidates() 只挑父目录已存在的项，不替用户新建目录。
 * WorkBuddy 的用户级 skill 目录是 ~/.workbuddy/skills（项目级 {workspace}/.workbuddy/skills 不在本机扫描范围）。
 */
export const AGENT_SKILL_DIRS: ReadonlyArray<{ agent: string; dir: string }> = [
  { agent: 'Claude Code', dir: '.claude/skills' },
  { agent: 'Codex', dir: '.codex/skills' },
  { agent: 'WorkBuddy', dir: '.workbuddy/skills' },
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
  /** App/CLI version, independent of skillSource's metadata.version. */
  version: string;
}
export interface IntegrationTarget {
  agent: string;
  path: string;
  /** missing：记在安装状态里、但目录已不存在（多半是用户删了）；对账不会重建它。 */
  status: 'installed' | 'skipped-foreign' | 'missing';
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

async function isManagedSkill(dir: string): Promise<boolean> {
  // Legacy markers contain an app version. Their presence proves ownership,
  // but their contents must never decide which skill version is installed.
  return (await entry(dir)) === 'dir' && (await entry(join(dir, MANAGED_FILE))) === 'file';
}

function skillReceipt(skillVersion: string): string {
  return `${JSON.stringify({ version: 1, skillVersion })}\n`;
}

/**
 * 原子写：同目录临时文件 → chmod → rename。目标若是符号链接，rename 会替换链接本身而不跟随，但我们先行拒绝。
 * 任何一步失败都删掉临时文件，不在目标旁边留 `.tmp`。
 */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode, flag: 'wx' });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 一个 skill 拷贝位置此刻的真实状态：带我们的标记才算 installed，同名但无标记是别人的。 */
async function targetStatus(
  path: string,
  absent: 'installed' | 'missing',
): Promise<IntegrationTarget['status']> {
  if ((await entry(path)) === 'missing') return absent;
  return (await isManagedSkill(path)) ? 'installed' : 'skipped-foreign';
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

  /** 安装会写到哪里：已存在的 Agent skills 目录各一个；还没有拷贝的位置记 installed（将要写入）。 */
  private async candidates(): Promise<IntegrationTarget[]> {
    const out: IntegrationTarget[] = [];
    for (const { agent, dir } of AGENT_SKILL_DIRS) {
      const parent = join(this.paths.home, dir);
      if ((await entry(parent)) !== 'dir') continue;
      const path = join(parent, SKILL_NAME);
      out.push({ agent, path, status: await targetStatus(path, 'installed') });
    }
    return out;
  }

  /** 已安装时：按安装状态里记下的位置逐个看磁盘，缺失的如实报 missing。 */
  private async liveTargets(targets: IntegrationTarget[]): Promise<IntegrationTarget[]> {
    const out: IntegrationTarget[] = [];
    for (const { agent, path } of targets)
      out.push({ agent, path, status: await targetStatus(path, 'missing') });
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
      targets: state ? await this.liveTargets(state.targets) : await this.candidates(),
    };
  }

  /**
   * 先做完所有「会拒绝」的检查，再签发客户端，避免拒绝时留下一个没用的 token。
   * 签发之后任何一步失败：调 rollback(新 clientId) 吊销刚签发的客户端，把 cli.token 恢复成安装前的内容
   * （首次安装则删掉），再抛出原错误。integration.json 最后才写，失败时保持安装前的样子，
   * 仍指向上一个仍然有效的客户端，设置页与后续清理照常可用。
   */
  async install(
    issue: () => Promise<{ clientId: string; token: string }>,
    rollback: (clientId: string) => Promise<void> = async () => undefined,
  ): Promise<IntegrationState> {
    const shimKind = await entry(this.shimPath);
    if (shimKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.shimPath}`);
    if (shimKind !== 'missing' && !(await isOurShim(this.shimPath)))
      throw new Error(`已存在不是 Pilion 生成的 ${this.shimPath}，请先移走它再安装 pilion 命令`);
    const tokenKind = await entry(this.tokenPath);
    if (tokenKind === 'symlink') throw new Error(`拒绝写入符号链接：${this.tokenPath}`);
    if ((await entry(this.statePath)) === 'symlink')
      throw new Error(`拒绝写入符号链接：${this.statePath}`);

    const skillVersion = await this.bundledSkillVersion();

    const previousToken = tokenKind === 'file' ? await readFile(this.tokenPath, 'utf8') : undefined;

    const { clientId, token } = await issue();

    try {
      await mkdir(this.paths.externalDir, { recursive: true, mode: 0o700 });
      await this.writeToken(`${token}\n`);
      await writeAtomic(this.shimPath, renderShim(this.paths), 0o755);
      const targets = await this.installSkills(skillVersion);

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
    } catch (error) {
      // 回滚失败不能盖住真正的错误：吊销与恢复 token 都尽力而为，最后抛原错误。
      await rollback(clientId).catch(() => undefined);
      await this.restoreToken(previousToken).catch(() => undefined);
      throw error;
    }
  }

  /** 写 cli.token：先删掉普通文件（前置检查已拒绝符号链接），再以 wx 新建，不跟随任何中途换上的链接。 */
  private async writeToken(content: string): Promise<void> {
    if ((await entry(this.tokenPath)) === 'file') await unlink(this.tokenPath);
    await writeFile(this.tokenPath, content, { mode: 0o600, flag: 'wx' });
    await chmod(this.tokenPath, 0o600);
  }

  private async restoreToken(previous: string | undefined): Promise<void> {
    if (previous === undefined) {
      if ((await entry(this.tokenPath)) === 'file') await unlink(this.tokenPath);
      return;
    }
    await this.writeToken(previous);
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
    const targets = await this.refreshSkills(state.targets);
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
      if (await isManagedSkill(path)) await rm(path, { recursive: true, force: true });
    }
    if ((await entry(this.statePath)) === 'file') await unlink(this.statePath);
    return state?.clientId;
  }

  private async bundledSkillVersion(): Promise<string> {
    const version = await readSkillVersion(this.paths.skillSource);
    if (!version)
      throw new Error('Invalid bundled skill metadata.version: expected major.minor.patch');
    return version;
  }

  /** 安装缺失的拷贝，升级旧 skill；重装也不能降级独立更新的 skill。 */
  private async installSkills(skillVersion: string): Promise<IntegrationTarget[]> {
    const targets = await this.candidates();
    for (const target of targets)
      if (target.status === 'installed') await this.upgradeSkill(target.path, skillVersion);
    return targets;
  }

  /** 启动对账：按 skill 自己的版本升级；缺失的报 missing，不重建。 */
  private async refreshSkills(recorded: IntegrationTarget[]): Promise<IntegrationTarget[]> {
    const skillVersion = await this.bundledSkillVersion();
    const targets = await this.liveTargets(recorded);
    for (const target of targets) {
      if (target.status !== 'installed') continue;
      await this.upgradeSkill(target.path, skillVersion);
    }
    return targets;
  }

  private async upgradeSkill(path: string, bundledVersion: string): Promise<void> {
    if ((await entry(path)) === 'missing') return this.writeCopy(path, bundledVersion);
    if (!(await isManagedSkill(path))) return;
    // External skill installers may update SKILL.md while leaving our receipt
    // untouched. The installed metadata is authoritative, never the receipt.
    const installedVersion = await readSkillVersion(path);
    if (!installedVersion) return;
    if (compareSkillVersions(installedVersion, bundledVersion) === -1) {
      await this.writeCopy(path, bundledVersion);
      return;
    }
    // Migrate legacy app-version markers without rewriting the skill itself.
    const marker = join(path, MANAGED_FILE);
    const receipt = skillReceipt(installedVersion);
    if ((await readFile(marker, 'utf8')) !== receipt) await writeAtomic(marker, receipt, 0o600);
  }

  /** 先拷到同目录临时目录再换上；失败时删掉临时目录，不在 skills 目录里留一个会被当成重复 skill 的半成品。 */
  private async writeCopy(path: string, skillVersion: string): Promise<void> {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await cp(this.paths.skillSource, tmp, { recursive: true, dereference: true });
      await writeFile(join(tmp, MANAGED_FILE), skillReceipt(skillVersion));
      await rm(path, { recursive: true, force: true });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
