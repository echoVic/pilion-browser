import { access, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  LOCAL_AGENTS,
  type LocalAgentEnvironment,
  type LocalAgentInput,
} from '../../shared/local-agents.js';
import type { AgentConfig } from '../../shared/contracts.js';
import type { AgentLaunchConfig } from './types.js';

const exec = promisify(execFile);
type DiscoveryOptions = {
  nodePath?: string;
  directories?: string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
};

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

async function cachedAdapter(
  preset: (typeof LOCAL_AGENTS)[number],
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!preset.package) return;
  const separator = preset.package.lastIndexOf('@');
  const name = preset.package.slice(0, separator);
  const version = preset.package.slice(separator + 1);
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
  const npx = await find('npx', options.directories ?? paths);
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
          : runtimeError || (!executablePath && !npx)
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
  options: DiscoveryOptions = {},
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
  if (found.executablePath) {
    const javascript = await isNodeProgram(found.executablePath);
    if (javascript && !environment.nodePath) throw new Error('未找到 Node.js');
    return {
      id: config.id,
      command: javascript ? environment.nodePath! : found.executablePath,
      args: [...(javascript ? [found.executablePath] : []), ...preset.args],
      cwd,
      env,
    };
  }
  if (!preset.package) throw new Error(`请先安装 ${preset.name} 官方 CLI`);
  if (!environment.nodePath) throw new Error(environment.error ?? '未找到 Node.js');
  const npx = await find('npx', options.directories ?? paths);
  if (!npx) throw new Error('未找到 npx，请选择包含 npm 的 Node.js 安装');
  return {
    id: config.id,
    command: environment.nodePath,
    args: [npx, '--yes', preset.package, ...preset.args],
    cwd,
    env,
  };
}
