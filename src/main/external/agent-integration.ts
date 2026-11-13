import { randomBytes } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { compareSkillVersions, readSkillVersion } from './agent-skill-package.js';
import { clientIdFromToken, ExternalClientRegistry } from './client-registry.js';

/**
 * 「安装到 Agent」：给本机终端 Agent 零配置接上 Pilion。
 * 负责四样本机文件，全部带「是我们写的」标记，绝不覆盖/删除没有标记的同名文件，任何写入点拒绝符号链接：
 *  - <externalDir>/cli.token（0600）：集成客户端的明文 token；
 *  - <home>/.local/bin/pilion（0755）：含 SHIM_MARKER 的 sh 包装脚本；
 *  - <home>/<agent>/skills/pilion-browser/：skill 拷贝，内含 MANAGED_FILE（所有权标记和独立 skill 版本）；
 *  - <externalDir>/integration.json（0600）：安装状态。
 * 签发客户端由调用方注入（主进程持有 ExternalControlServer），本模块只做文件系统；
 * 唯一的例外是对账时只读地查一遍客户端注册表，找出没有安装记录认领的集成客户端（见 orphanedClientIds）。
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
/** 旧版还写过一个 shimPath 字段：读的时候照样接受，写回时不再带上。 */
export interface IntegrationState {
  version: 1;
  clientId: string;
  installedAt: string;
  appVersion: string;
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
  /** 已安装时才有：安装记录在、但本机文件缺了或对不上，每条是一句给人看的说明。 */
  problems?: string[];
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

/** 常见 shell 的启动文件：Pilion 从访达/启动台打开时拿不到用户 shell 的 PATH，只能看这些文件。 */
const SHELL_STARTUP_FILES = [
  '.zshenv',
  '.zprofile',
  '.zshrc',
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.config/fish/config.fish',
];
/** 启动文件不该很大；超过这个就不读，免得一个指向大文件的链接拖慢设置页。 */
const STARTUP_FILE_MAX_BYTES = 256 * 1024;

/**
 * 尽力而为、只读：用户的 shell 启动文件里有没有把 ~/.local/bin 加进 PATH 的一行。
 * 只做文本匹配（不执行任何东西），注释行不算；读不了的文件当作没有。
 */
async function startupFilesAddDir(home: string, dir: string): Promise<boolean> {
  const forms = [dir, '~/.local/bin', '$HOME/.local/bin', '${HOME}/.local/bin'];
  for (const name of SHELL_STARTUP_FILES) {
    const path = join(home, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > STARTUP_FILE_MAX_BYTES) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !forms.some((form) => line.includes(form))) continue;
      // `export PATH=…`、`path+=(…)`、`fish_add_path …`，或 uv 这类安装器加的 `. "$HOME/.local/bin/env"`。
      if (/path/i.test(line) || /\.local\/bin\/env\b/.test(line)) return true;
    }
  }
  return false;
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
      // skills 目录本身可以是符号链接（dotfiles 仓库里很常见），只要它指向一个目录；
      // skill 自己的位置仍然不接受符号链接（targetStatus 会把它当成别人的）。
      const kind = await entry(parent);
      if (
        kind === 'symlink'
          ? !(await stat(parent).catch(() => undefined))?.isDirectory()
          : kind !== 'dir'
      )
        continue;
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
    const pathHasShimDir =
      (this.env.PATH ?? '').split(delimiter).includes(shimDir) ||
      (await startupFilesAddDir(this.paths.home, shimDir));
    return {
      installed: Boolean(state),
      ...(state ? { clientId: state.clientId, installedAt: state.installedAt } : {}),
      shimPath: this.shimPath,
      shimConflict,
      pathHasShimDir,
      targets: state ? await this.liveTargets(state.targets) : await this.candidates(),
      ...(state ? { problems: await this.problems(state, shimKind) } : {}),
    };
  }

  /** 安装记录在，但 `pilion` 实际用不了的几种情况。 */
  private async problems(state: IntegrationState, shimKind: Entry): Promise<string[]> {
    const problems: string[] = [];
    if ((await entry(this.tokenPath)) !== 'file') {
      problems.push(`凭证文件 ${this.tokenPath} 不见了：请重新「安装到 Agent」`);
    } else {
      const token = (await readFile(this.tokenPath, 'utf8').catch(() => '')).trim();
      if (clientIdFromToken(token) !== state.clientId)
        problems.push(`凭证文件 ${this.tokenPath} 和安装记录对不上：请重新「安装到 Agent」`);
    }
    if (shimKind === 'missing')
      problems.push(
        `pilion 命令 ${this.shimPath} 不见了：重启 Pilion 会补回，或重新「安装到 Agent」`,
      );
    return problems;
  }

  /**
   * 注册表里还有效、却没有安装记录认领的集成客户端：签发之后、写完安装记录之前进程挂了，
   * 或重装成功后、吊销旧客户端之前挂了，都会留下这样一个没人管的有效凭证。
   * 安装记录存在却读不懂时无从判断，返回空（下次装好后再清）。只读，不改注册表。
   */
  async orphanedClientIds(): Promise<string[]> {
    const state = await this.readState();
    if (!state && (await entry(this.statePath)) !== 'missing') return [];
    const clients = await new ExternalClientRegistry(this.paths.externalDir).list();
    return clients
      .filter(
        (c) => c.kind === 'agent-integration' && !c.revokedAt && c.clientId !== state?.clientId,
      )
      .map((c) => c.clientId);
  }

  /**
   * 先做完所有「会拒绝」的检查，再签发客户端，避免拒绝时留下一个没用的 token。
   * 签发之后任何一步失败：调 rollback(新 clientId) 吊销刚签发的客户端，把 cli.token 恢复成安装前的内容
   * （首次安装则删掉），删掉这次新建出来的 shim 与 skill 拷贝（原来就有的不动），再抛出原错误。
   * integration.json 最后才写，失败时保持安装前的样子，仍指向上一个仍然有效的客户端，设置页与后续清理照常可用。
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

    /** 这次安装新建出来的 skill 拷贝（安装前那里什么都没有）；失败时只删它们。 */
    const createdCopies: string[] = [];
    try {
      await mkdir(this.paths.externalDir, { recursive: true, mode: 0o700 });
      await this.writeToken(`${token}\n`);
      await writeAtomic(this.shimPath, renderShim(this.paths), 0o755);
      const targets = await this.installSkills(skillVersion, createdCopies);

      const state: IntegrationState = {
        version: 1,
        clientId,
        installedAt: new Date().toISOString(),
        appVersion: this.paths.version,
        targets,
      };
      await writeAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      return state;
    } catch (error) {
      // 回滚失败不能盖住真正的错误：吊销、恢复 token、清理新建文件都尽力而为，最后抛原错误。
      await rollback(clientId).catch(() => undefined);
      await this.restoreToken(previousToken).catch(() => undefined);
      await this.removeCreated(shimKind === 'missing', createdCopies).catch(() => undefined);
      throw error;
    }
  }

  /** 撤掉失败安装新建的文件：shim 只在安装前不存在时删，拷贝只删这次新建、且仍带我们标记的。 */
  private async removeCreated(shimCreated: boolean, copies: string[]): Promise<void> {
    if (shimCreated && (await isOurShim(this.shimPath))) await unlink(this.shimPath);
    for (const path of copies)
      if (await isManagedSkill(path)) await rm(path, { recursive: true, force: true });
  }

  /**
   * 写 cli.token：原子替换。rename 替换的是路径本身，不跟随中途换上的符号链接；
   * 重装期间并发的 `pilion` 命令读到的要么是旧凭证要么是新凭证，不会撞上「文件不存在」。
   */
  private async writeToken(content: string): Promise<void> {
    await writeAtomic(this.tokenPath, content, 0o600);
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
    ) {
      // 显式列出字段：旧版文件里的 shimPath 不再写回。
      const next: IntegrationState = {
        version: 1,
        clientId: state.clientId,
        installedAt: state.installedAt,
        appVersion: this.paths.version,
        targets,
      };
      await writeAtomic(this.statePath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    }
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

  /** 安装缺失的拷贝，升级旧 skill；重装也不能降级独立更新的 skill。新建出来的拷贝记进 created。 */
  private async installSkills(
    skillVersion: string,
    created: string[],
  ): Promise<IntegrationTarget[]> {
    const targets = await this.candidates();
    for (const target of targets) {
      if (target.status !== 'installed') continue;
      const fresh = (await entry(target.path)) === 'missing';
      await this.upgradeSkill(target.path, skillVersion);
      if (fresh) created.push(target.path);
    }
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
