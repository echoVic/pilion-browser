import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  LOCAL_AGENTS,
  type LocalAgentDefinition,
  type LocalAgentEnvironment,
  type LocalAgentInput,
} from '../../shared/local-agents.js';
import type { AdapterInstallState, AgentConfig } from '../../shared/contracts.js';
import type { AgentLaunchConfig } from './types.js';

const exec = promisify(execFile);
type DiscoveryOptions = {
  nodePath?: string;
  directories?: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Pilion 自己安装 ACP 适配器的目录（userData/adapters）；不传就既不在这里找，也不安装。 */
  adaptersRoot?: string;
};
export type LaunchOptions = DiscoveryOptions & {
  /** 开始安装适配器时调用：首次安装可能要几分钟，调用方据此告诉人在等什么。 */
  onInstall?: (preset: LocalAgentDefinition) => void;
  onInstallProgress?: (state: AdapterInstallState | undefined) => void;
  installTimeoutMs?: number;
};

/**
 * 安装适配器的时间上限。Claude 的适配器带着近 90 MB 的原生程序，慢网下要好几分钟。
 * 安装单独计时，不占用 ACP 握手的超时，也不会在下载到一半时被握手超时打断。
 */
export const ADAPTER_INSTALL_TIMEOUT_MS = 15 * 60_000;

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) return;
    return await realpath(path);
  } catch {
    return;
  }
}
async function find(name: string, directories: string[]): Promise<string | undefined> {
  for (const directory of directories) {
    const path = await executable(join(directory, name));
    if (path) return path;
  }
}

function packageSpec(preset: LocalAgentDefinition): { name: string; version: string } | undefined {
  if (!preset.package) return;
  const separator = preset.package.lastIndexOf('@');
  return { name: preset.package.slice(0, separator), version: preset.package.slice(separator + 1) };
}

async function cachedAdapter(
  preset: LocalAgentDefinition,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const spec = packageSpec(preset);
  if (!spec) return;
  const { name, version } = spec;
  const cache = join(env.npm_config_cache || env.NPM_CONFIG_CACHE || join(home, '.npm'), '_npx');
  try {
    for (const entry of (await readdir(cache)).slice(0, 200)) {
      try {
        const root = join(cache, entry, 'node_modules');
        const metadata = JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'));
        if (metadata.name !== name || metadata.version !== version) continue;
        const binary = await executable(join(root, '.bin', preset.executable));
        if (binary) return binary;
      } catch {
        /* other cached packages are unrelated */
      }
    }
  } catch {
    /* npx may not have been used yet */
  }
}

/** adapters/<去掉 @ 的包名，/ 换成 __>@<版本>：每个固定版本一个目录，升级版本时不会和旧的混在一起。 */
function adapterDirectory(root: string, name: string, version: string): string {
  return join(root, `${name.replace(/^@/, '').replace(/\//g, '__')}@${version}`);
}

/** Pilion 装好的适配器：包名和版本都对得上、.bin 入口在，才算装好。 */
async function installedAdapter(
  preset: LocalAgentDefinition,
  root: string | undefined,
): Promise<string | undefined> {
  const spec = packageSpec(preset);
  if (!root || !spec) return;
  const directory = adapterDirectory(root, spec.name, spec.version);
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, 'node_modules', spec.name, 'package.json'), 'utf8'),
    );
    if (metadata.name !== spec.name || metadata.version !== spec.version) return;
  } catch {
    return;
  }
  return executable(join(directory, 'node_modules', '.bin', preset.executable));
}

async function isNodeProgram(path: string): Promise<boolean> {
  if (/\.[cm]?js$/.test(path)) return true;
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return /^#![^\n]*\bnode\b/.test(buffer.subarray(0, bytesRead).toString());
  } finally {
    await file.close();
  }
}

/**
 * An interrupted npx or npm install leaves the adapter's own files in place while its
 * dependencies are missing. The adapter then looks installed and only fails after spawning,
 * so the incomplete tree is detected here and the preset falls back to reinstalling.
 */
async function hasCompleteDependencies(path: string): Promise<boolean> {
  let directory = dirname(path);
  let metadata: { dependencies?: Record<string, string> } | undefined;
  for (let depth = 0; depth < 6 && !metadata; depth += 1) {
    try {
      metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      break;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return true;
      directory = parent;
    }
  }
  const dependencies = Object.keys(metadata?.dependencies ?? {});
  for (const dependency of dependencies) {
    let search = directory;
    let resolved = false;
    for (let depth = 0; depth < 12 && !resolved; depth += 1) {
      try {
        await stat(join(search, 'node_modules', dependency, 'package.json'));
        resolved = true;
      } catch {
        const parent = dirname(search);
        if (parent === search) break;
        search = parent;
      }
    }
    if (!resolved) return false;
  }
  return true;
}

async function belongsToPackage(path: string, name: string): Promise<boolean> {
  let directory = dirname(path);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      return metadata.name === name;
    } catch {
      /* try the package's parent */
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return false;
}

function satisfiesNode(version: string, minimum: readonly number[]): boolean {
  const actual = version.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export async function localSearchDirectories(
  home = homedir(),
  env = process.env,
): Promise<string[]> {
  const directories = (env.PATH ?? '').split(delimiter).filter((path) => isAbsolute(path));
  directories.push(
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(home, '.volta/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.grok/bin'),
    join(home, '.opencode/bin'),
    join(home, '.bun/bin'),
    join(home, '.local/share/pnpm'),
  );
  try {
    const root = join(home, '.nvm/versions/node');
    const versions = await readdir(root);
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    directories.push(...versions.map((version) => join(root, version, 'bin')));
  } catch {
    /* nvm is optional */
  }
  return [...new Set(directories)];
}

export async function inspectLocalAgents(
  options: DiscoveryOptions = {},
): Promise<LocalAgentEnvironment> {
  const home = options.home ?? homedir();
  const directories = options.directories ?? (await localSearchDirectories(home, options.env));
  const requested = options.nodePath?.trim();
  const nodePath = requested
    ? isAbsolute(requested)
      ? await executable(requested)
      : undefined
    : await find('node', directories);
  let nodeVersion: string | undefined;
  let error: string | undefined;
  if (nodePath) {
    try {
      const result = await exec(nodePath, ['--version'], {
        timeout: 5_000,
        maxBuffer: 4096,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      nodeVersion = result.stdout.trim();
      if (!/^v\d+\./.test(nodeVersion) || Number(nodeVersion.match(/^v(\d+)/)?.[1] ?? 0) < 22)
        error = '需要 Node.js 22 或更新版本';
    } catch {
      error = '无法启动所选 Node.js';
    }
  } else
    error = requested ? 'Node.js 路径必须指向可执行文件的绝对路径' : '未找到 Node.js 22 或更新版本';
  const paths =
    options.directories ?? (nodePath ? [dirname(nodePath), ...directories] : directories);
  const npm = await find('npm', options.directories ?? paths);
  const agents = await Promise.all(
    LOCAL_AGENTS.map(async (preset) => {
      let executablePath = await find(preset.executable, paths);
      for (const alias of preset.aliases) executablePath ??= await find(alias, paths);
      if (
        executablePath &&
        preset.requiredPackageName &&
        !(await belongsToPackage(executablePath, preset.requiredPackageName))
      )
        executablePath = undefined;
      executablePath ??= await installedAdapter(preset, options.adaptersRoot);
      if (!options.directories)
        executablePath ??= await cachedAdapter(preset, home, options.env ?? process.env);
      if (
        executablePath &&
        (await isNodeProgram(executablePath)) &&
        !(await hasCompleteDependencies(executablePath))
      )
        executablePath = undefined;
      const cliPath = await find(preset.cli, paths);
      const needsNode = !executablePath || (await isNodeProgram(executablePath));
      const runtimeError = needsNode
        ? error ||
          (preset.minNode && nodeVersion && !satisfiesNode(nodeVersion, preset.minNode)
            ? `${preset.name} 需要 Node.js ${preset.minNode.join('.')} 或更新版本`
            : undefined)
        : undefined;
      const missingCli = !executablePath && !preset.package;
      return {
        id: preset.id,
        executablePath,
        cliPath,
        error: missingCli ? `未找到 ${preset.name}，请先安装其官方 CLI` : runtimeError,
        status: missingCli
          ? ('cli_missing' as const)
          : runtimeError || (!executablePath && !npm)
            ? ('runtime_missing' as const)
            : executablePath
              ? ('ready' as const)
              : ('install_required' as const),
      };
    }),
  );
  return { nodePath, nodeVersion, error, defaultCwd: home, agents };
}

export function presetConfiguration(input: LocalAgentInput, cwd: string): AgentConfig {
  const preset = LOCAL_AGENTS.find((item) => item.id === input.preset)!;
  return {
    id: `local:${preset.id}`,
    name: preset.name,
    preset: preset.id,
    command: preset.executable,
    args: [...preset.args],
    transport: 'stdio',
    enabled: true,
    cwd,
    nodePath: input.nodePath?.trim() || undefined,
  };
}

/** Resolve at connection time so an nvm upgrade or a later adapter install is picked up. */
export async function resolveLocalLaunch(
  config: AgentConfig,
  options: LaunchOptions = {},
): Promise<AgentLaunchConfig> {
  if (!config.preset) return config;
  const preset = LOCAL_AGENTS.find((item) => item.id === config.preset)!;
  const environment = await inspectLocalAgents({
    ...options,
    nodePath: config.nodePath ?? options.nodePath,
  });
  const found = environment.agents.find((item) => item.id === config.preset)!;
  if (found.error) throw new Error(found.error);
  const cwd = config.cwd || environment.defaultCwd;
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error('工作目录不存在或不是绝对路径');
  const directories =
    options.directories ?? (await localSearchDirectories(options.home, options.env));
  const paths = [
    ...new Set([...(environment.nodePath ? [dirname(environment.nodePath)] : []), ...directories]),
  ];
  const env: Record<string, string> = {
    ...config.env,
    PATH: paths.join(delimiter),
  };
  const inherited = options.env ?? process.env;
  // Keep ACP on a single stdio owner; Gemini's relaunch wrapper can consume initialization input.
  if (config.preset === 'gemini') env.GEMINI_CLI_NO_RELAUNCH = '1';
  for (const key of preset.authEnv)
    if (env[key] === undefined && inherited[key]) env[key] = inherited[key]!;
  let executablePath = found.executablePath;
  if (!executablePath) {
    // 先把适配器装好再启动。用 npx 现装现跑时，下载算进了握手超时：慢网下载到一半被结束，
    // npx 缓存里留下的半成品会让之后每次连接都在两秒内失败。
    if (!preset.package) throw new Error(`请先安装 ${preset.name} 官方 CLI`);
    if (!environment.nodePath) throw new Error(environment.error ?? '未找到 Node.js');
    const npm = await find('npm', options.directories ?? paths);
    if (!npm) throw new Error('未找到 npm，请选择包含 npm 的 Node.js 安装');
    if (!options.adaptersRoot) throw new Error(`未找到 ${preset.name} 的 ACP 适配器`);
    executablePath = await installAdapter(preset, {
      root: options.adaptersRoot,
      node: environment.nodePath,
      npm,
      env: installEnvironment(paths, options.home, inherited),
      timeoutMs: options.installTimeoutMs ?? ADAPTER_INSTALL_TIMEOUT_MS,
      onInstall: options.onInstall,
      onInstallProgress: options.onInstallProgress,
    });
  }
  const javascript = await isNodeProgram(executablePath);
  if (javascript && !environment.nodePath) throw new Error('未找到 Node.js');
  return {
    id: config.id,
    command: javascript ? environment.nodePath! : executablePath,
    args: [...(javascript ? [executablePath] : []), ...preset.args],
    cwd,
    env,
  };
}

type InstallRequest = {
  root: string;
  node: string;
  npm: string;
  env: Record<string, string>;
  timeoutMs: number;
  onInstall?: (preset: LocalAgentDefinition) => void;
  onInstallProgress?: (state: AdapterInstallState | undefined) => void;
};

const installing = new Map<string, Promise<string>>();
/** 正在运行的 npm：它跑在自己的进程组里（超时才能整组结束），所以不会跟着 Pilion 一起退出。 */
const npmProcesses = new Set<ChildProcess>();
const abortedProcesses = new WeakSet<ChildProcess>();

/** Pilion 退出时结束还在进行的适配器安装，不让 npm 留在后台继续下载。 */
export function abortAdapterInstalls(): void {
  for (const child of npmProcesses) {
    abortedProcesses.add(child);
    killProcessGroup(child);
  }
}

/**
 * 把适配器装进 adapters 下它自己的目录：先装进旁边的临时目录，npm 成功退出后再整个改名过去。
 * 安装被打断、失败或超时都不会留下「看起来装好了」的目录；同一个适配器同时只装一次。
 */
function installAdapter(preset: LocalAgentDefinition, request: InstallRequest): Promise<string> {
  const spec = packageSpec(preset)!;
  const target = adapterDirectory(request.root, spec.name, spec.version);
  const running = installing.get(target);
  if (running) return running;
  const install = (async () => {
    await mkdir(request.root, { recursive: true });
    await clearStaleStaging(request.root, basename(target), request.timeoutMs);
    const staging = `${target}.installing-${randomUUID()}`;
    const cache = `${staging}.npm-cache`;
    const progress: AdapterInstallState = {
      presetId: preset.id,
      name: preset.name,
      package: preset.package!,
      startedAt: Date.now(),
    };
    const stopProgress = trackInstallProgress(cache, progress, request.onInstallProgress);
    try {
      request.onInstall?.(preset);
      await mkdir(staging);
      await runNpmInstall(request, staging, cache, preset);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      const script = await installedAdapter(preset, request.root);
      if (!script || ((await isNodeProgram(script)) && !(await hasCompleteDependencies(script))))
        throw new Error(`${preset.name} 的 ACP 适配器安装后不完整，请重试`);
      await removeOtherAdapterVersions(request.root, spec.name, spec.version);
      return script;
    } finally {
      stopProgress();
      try {
        await Promise.all([
          rm(staging, { recursive: true, force: true }),
          rm(cache, { recursive: true, force: true }),
        ]);
      } finally {
        request.onInstallProgress?.(undefined);
      }
    }
  })().finally(() => installing.delete(target));
  installing.set(target, install);
  return install;
}

/** 采样串行进行；结束后即使读目录还没返回，也不会再广播进度。 */
function trackInstallProgress(
  cache: string,
  progress: AdapterInstallState,
  report: InstallRequest['onInstallProgress'],
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  report?.(progress);
  async function sample(): Promise<void> {
    let downloadedBytes: number | undefined;
    try {
      downloadedBytes = await directoryBytes(cache);
    } catch {
      /* 缓存尚未创建或正在改写时，留空即可，不影响安装。 */
    }
    if (stopped) return;
    report?.({ ...progress, downloadedBytes });
    timer = setTimeout(() => void sample(), 1000);
  }
  timer = setTimeout(() => void sample(), 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

/** 只有新版本完整安装后才清理同包旧版本，不碰 PATH、npx 缓存和其他包。 */
async function removeOtherAdapterVersions(
  root: string,
  name: string,
  version: string,
): Promise<void> {
  const prefix = `${basename(adapterDirectory(root, name, ''))}`;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const installedVersion = entry.name.slice(prefix.length).split('.installing-')[0];
    if (installedVersion && installedVersion !== version)
      await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

/** 上次被打断的 staging 和旁边的私有缓存，超过安装时限才清理。 */
async function clearStaleStaging(root: string, name: string, timeoutMs: number): Promise<void> {
  for (const entry of await readdir(root)) {
    if (!entry.startsWith(`${name}.installing-`)) continue;
    const path = join(root, entry);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > timeoutMs)
        await rm(path, { recursive: true, force: true });
    } catch {
      /* another Pilion already removed it */
    }
  }
}

async function runNpmInstall(
  request: InstallRequest,
  prefix: string,
  cache: string,
  preset: LocalAgentDefinition,
): Promise<void> {
  const child = spawn(
    request.node,
    [
      request.npm,
      'install',
      '--prefix',
      prefix,
      '--cache',
      cache,
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--loglevel=error',
      preset.package!,
    ],
    {
      cwd: prefix,
      env: request.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    },
  );
  npmProcesses.add(child);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  let timedOut = false;
  // npm 收到 SIGTERM 会等手上的下载做完才退（大包要好几分钟），超时就直接结束它整组进程。
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child);
  }, request.timeoutMs);
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once('error', (error) => {
        clearTimeout(timer);
        npmProcesses.delete(child);
        reject(error);
      });
      child.once('close', (exitCode, exitSignal) => {
        clearTimeout(timer);
        npmProcesses.delete(child);
        resolve([exitCode, exitSignal]);
      });
    },
  );
  if (abortedProcesses.has(child))
    throw new Error(`安装 ${preset.name} 的 ACP 适配器已取消：Pilion 正在退出`);
  if (timedOut) {
    const limit =
      request.timeoutMs >= 60_000
        ? `${Math.round(request.timeoutMs / 60_000)} 分钟`
        : `${Math.round(request.timeoutMs / 1000)} 秒`;
    throw new Error(`安装 ${preset.name} 的 ACP 适配器超时（${limit}），请检查网络后重试`);
  }
  if (code !== 0) {
    const output = lastLines(stderr, 12);
    const ending = code === null ? `被 ${signal} 结束` : `退出码 ${code}`;
    throw new Error(
      `安装 ${preset.name} 的 ACP 适配器失败（npm ${ending}）${output ? `：\n${output}` : ''}`,
    );
  }
}

function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function lastLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join('\n')
    .slice(-1500);
}

/** npm 需要的环境：PATH 指向选定的 Node，HOME 决定 ~/.npmrc 和下载缓存，代理与 npm_config_* 原样带上。 */
function installEnvironment(
  paths: string[],
  home: string | undefined,
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = { PATH: paths.join(delimiter) };
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (
      ['USER', 'TMPDIR', 'TEMP', 'LANG', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA'].includes(key) ||
      /^npm_config_/i.test(key) ||
      /^(https?|no|all)_proxy$/i.test(key)
    )
      env[key] = value;
  }
  const userHome = home ?? inherited.HOME;
  if (userHome) env.HOME = userHome;
  return env;
}
