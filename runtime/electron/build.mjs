#!/usr/bin/env node
import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv.shift() ?? 'help';
const value = (name, fallback) => {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw Error(`Missing ${name}`);
  return argv[at + 1];
};
const root = resolve(value('--root', join(homedir(), '.cache/pilion-electron-build')));
const source = resolve(value('--source', join(root, 'src/electron')));
const arch = value('--arch', process.arch);
const json = argv.includes('--json');
const developerDir = value('--developer-dir', process.env.DEVELOPER_DIR);
const baseEnv = { ...process.env, ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}) };
const lockPath = resolve(value('--lock', join(here, 'build-lock.json')));
const capture = (cmd, args, options = {}) =>
  new Promise((accept, reject) => {
    const child = spawn(cmd, args, {
      env: baseEnv,
      ...options,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? accept(stdout.trim())
        : reject(Error(`${cmd} failed (${code}): ${stderr || stdout}`)),
    );
  });
const run = (cmd, args, options = {}) =>
  new Promise((accept, reject) => {
    console.log('+', cmd, ...args);
    const child = spawn(cmd, args, { env: baseEnv, ...options, shell: false, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? accept() : reject(Error(`${cmd} exited ${code}`))));
  });
async function lock() {
  const result = JSON.parse(await readFile(lockPath, 'utf8'));
  if (
    !/^[a-f0-9]{40}$/.test(result.electronCommit) ||
    !/^[a-f0-9]{40}$/.test(result.depotToolsCommit)
  )
    throw Error('Invalid pinned source commit');
  const patch = resolve(dirname(lockPath), result.patch);
  if (!patch.startsWith(dirname(lockPath) + '/'))
    throw Error('Patch must be inside the runtime directory');
  const digest = createHash('sha256')
    .update(await readFile(patch))
    .digest('hex');
  if (digest !== result.patchSha256) throw Error('Native patch SHA-256 mismatch');
  return { ...result, patch };
}
async function doctor() {
  const checks = [];
  const check = async (name, cmd, args) => {
    try {
      checks.push({ name, ok: true, detail: await capture(cmd, args) });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
  };
  await check('git', 'git', ['--version']);
  await check('python3', 'python3', ['--version']);
  if (process.platform === 'darwin') {
    await check('full Xcode', 'xcodebuild', ['-version']);
    await check('Interface Builder', 'xcrun', ['--find', 'ibtool']);
    await check('Asset Catalog compiler', 'xcrun', ['--find', 'actool']);
    await check('macOS SDK', 'xcrun', ['--show-sdk-path']);
  } else if (process.platform === 'linux') {
    await check('clang', 'clang', ['--version']);
    await check('pkg-config', 'pkg-config', ['--version']);
  } else {
    checks.push({
      name: 'platform',
      ok: false,
      detail:
        'This build wrapper currently supports macOS and Linux. Windows needs its native Visual Studio build workflow.',
    });
  }
  return { ok: checks.every((check) => check.ok), platform: process.platform, arch, checks };
}
async function requireToolchain() {
  const result = await doctor();
  if (!result.ok)
    throw Error(
      `Native toolchain unavailable:\n${result.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.name}: ${c.detail}`)
        .join('\n')}`,
    );
}
async function verifySource(expected) {
  const commit = await capture('git', ['rev-parse', 'HEAD'], { cwd: source });
  if (commit !== expected.electronCommit)
    throw Error(`Electron source is ${commit}; expected ${expected.electronCommit}`);
  const deps = await readFile(join(source, 'DEPS'), 'utf8');
  if (!deps.includes(expected.chromiumVersion))
    throw Error('Pinned Chromium version missing from DEPS');
}
async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
async function verifyPatchedSource(expected) {
  await verifySource(expected);
  const temporary = await mkdtemp(join(tmpdir(), 'pilion-source-index-'));
  try {
    const expectedEnv = { ...baseEnv, GIT_INDEX_FILE: join(temporary, 'expected-index') };
    await capture('git', ['read-tree', 'HEAD'], { cwd: source, env: expectedEnv });
    await capture('git', ['apply', '--cached', expected.patch], { cwd: source, env: expectedEnv });
    const expectedTree = await capture('git', ['write-tree'], { cwd: source, env: expectedEnv });
    const actualEnv = { ...baseEnv, GIT_INDEX_FILE: join(temporary, 'actual-index') };
    await capture('git', ['read-tree', 'HEAD'], { cwd: source, env: actualEnv });
    await capture('git', ['add', '-A', '--', '.'], { cwd: source, env: actualEnv });
    const actualTree = await capture('git', ['write-tree'], { cwd: source, env: actualEnv });
    if (actualTree !== expectedTree)
      throw Error(
        'Source must contain exactly the pinned native patch, without missing or unrelated changes',
      );
    return expectedTree;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function verifyTools(expected) {
  const commit = await capture('git', ['rev-parse', 'HEAD'], { cwd: tools });
  if (commit !== expected.depotToolsCommit)
    throw Error(`depot_tools is ${commit}; expected ${expected.depotToolsCommit}`);
  if (await capture('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: tools }))
    throw Error('depot_tools has tracked local changes');
  return commit;
}
export function parseFixtureOutput(stdout, phase, expected, platform, targetArch) {
  const markers = stdout.split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && 'phase' in value ? [value] : [];
    } catch {
      return [];
    }
  });
  if (markers.length !== 1)
    throw Error(`Native fixture ${phase} did not emit exactly one phase marker`);
  const marker = markers[0];
  const enabled = ['register', 'restore'].includes(phase);
  if (marker.phase !== phase || marker.injected !== enabled || marker.allowed !== enabled)
    throw Error(`Native fixture ${phase} emitted an invalid behavior marker`);
  const runtime = marker.runtime;
  if (
    !runtime ||
    runtime.electron !== expected.electronTag.replace(/^v/, '') ||
    runtime.chromium !== expected.chromiumVersion ||
    runtime.platform !== platform ||
    runtime.arch !== targetArch
  )
    throw Error(`Native fixture ${phase} runtime identity differs from the pinned target`);
  return marker;
}
async function extractRuntime(zip, destination) {
  // Extract regular files first, then validated links. No archive entry may be
  // written through a link, and every final link must resolve inside the archive.
  await capture('python3', [
    '-c',
    `
import os, pathlib, shutil, stat, sys, zipfile
root = pathlib.Path(sys.argv[2]).resolve()
root.mkdir(parents=True)
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = []
    links = []
    names = set()
    for entry in archive.infolist():
        path = pathlib.PurePosixPath(entry.filename)
        if path.is_absolute() or '..' in path.parts or chr(92) in entry.filename or not path.parts:
            raise ValueError('Unsafe archive path')
        name = str(path)
        if name in names:
            raise ValueError('Duplicate archive path')
        names.add(name)
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            links.append((path, archive.read(entry).decode('utf-8')))
        else:
            if mode and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_IFMT(mode) == 0):
                raise ValueError('Unsupported archive entry')
            entries.append((entry, path, mode))
    for name in names:
        if any(name.startswith(str(link) + '/') for link, _ in links):
            raise ValueError('Archive writes through a symbolic link')
    for entry, path, mode in entries:
        target = root.joinpath(*path.parts)
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod((mode & 0o777) or 0o644)
    for path, link in links:
        if pathlib.PurePosixPath(link).is_absolute() or chr(92) in link:
            raise ValueError('Unsafe archive link')
        target = root.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(link)
    for path, _ in links:
        if not root.joinpath(*path.parts).resolve(strict=True).is_relative_to(root):
            raise ValueError('Archive link escapes extraction directory')
`,
    zip,
    destination,
  ]);
  return join(
    destination,
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
  );
}
async function apply(expected) {
  await verifySource(expected);
  let alreadyApplied = false;
  try {
    await capture('git', ['apply', '--reverse', '--check', expected.patch], { cwd: source });
    alreadyApplied = true;
  } catch {
    /* A clean source may still need the pinned patch. */
  }
  if (alreadyApplied) {
    const tree = await verifyPatchedSource(expected);
    console.log('Native patch already applied');
    return tree;
  }
  if (await capture('git', ['status', '--porcelain'], { cwd: source }))
    throw Error('Refusing to apply the native patch to modified source');
  await capture('git', ['apply', '--check', expected.patch], { cwd: source });
  await run('git', ['apply', expected.patch], { cwd: source });
  return verifyPatchedSource(expected);
}

const out = `out/Pilion-${arch}`;
const tools = join(root, 'depot_tools');
const toolEnv = {
  ...baseEnv,
  PATH: `${tools}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
  DEPOT_TOOLS_UPDATE: '0',
  GIT_CACHE_PATH: join(root, 'git-cache'),
  CIPD_CACHE_DIR: join(root, 'cipd-cache'),
};
const gnArgs = `import("//electron/build/args/release.gn") target_cpu="${arch}" use_remoteexec=false use_siso=true symbol_level=0 v8_symbol_level=0 blink_symbol_level=0`;
async function main() {
  if (command === 'help') {
    console.log(
      'build.mjs doctor|validate|plan|bootstrap|apply|build|verify [--root DIR] [--source DIR] [--arch arm64|x64] [--binary GENERIC_ELECTRON] [--zip DIST_ZIP] [--json]',
    );
    return;
  }
  if (command === 'doctor') {
    const result = await doctor();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  const expected = await lock();
  if (!['arm64', 'x64'].includes(arch)) throw Error('Only native arm64/x64 targets are configured');
  if (command === 'validate') {
    if (argv.includes('--source')) await verifySource(expected);
    console.log(
      JSON.stringify({
        ok: true,
        electron: expected.electronTag,
        commit: expected.electronCommit,
        patchSha256: expected.patchSha256,
      }),
    );
    return;
  }
  if (['plan', 'bootstrap', 'build'].includes(command) && source !== resolve(root, 'src/electron'))
    throw Error(
      'Build source must be ROOT/src/electron; standalone --source is for apply/validate only',
    );
  if (command === 'plan') {
    console.log(
      JSON.stringify(
        {
          root,
          source,
          arch,
          electron: expected.electronTag,
          patchSha256: expected.patchSha256,
          commands: [
            [
              'gclient',
              'config',
              '--name',
              'src/electron',
              '--unmanaged',
              'https://github.com/electron/electron',
            ],
            [
              'gclient',
              'sync',
              '--nohooks',
              '--no-history',
              '--shallow',
              `--revision=src/electron@${expected.electronCommit}`,
            ],
            ['git', 'apply', expected.patch],
            ['gclient', 'runhooks'],
            ['gn', 'gen', out, `--args=${gnArgs}`],
            ['autoninja', '-C', out, 'electron', 'electron:electron_dist_zip'],
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'apply') {
    await apply(expected);
    return;
  }
  if (command === 'bootstrap') {
    await requireToolchain();
    await mkdir(root, { recursive: true });
    try {
      await access(join(tools, '.git'));
    } catch {
      await run('git', [
        'clone',
        'https://chromium.googlesource.com/chromium/tools/depot_tools.git',
        tools,
      ]);
    }
    if (await capture('git', ['status', '--porcelain'], { cwd: tools }))
      throw Error('depot_tools has local changes');
    await run('git', ['checkout', '--detach', expected.depotToolsCommit], { cwd: tools });
    await verifyTools(expected);
    try {
      const config = await readFile(join(root, '.gclient'), 'utf8');
      if (
        !config.includes('src/electron') ||
        !config.includes('https://github.com/electron/electron')
      )
        throw Error('Refusing an unrelated gclient root');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await run(
        'gclient',
        ['config', '--name', 'src/electron', '--unmanaged', 'https://github.com/electron/electron'],
        { cwd: root, env: toolEnv },
      );
    }
    await run(
      'gclient',
      [
        'sync',
        '--nohooks',
        '--no-history',
        '--shallow',
        `--revision=src/electron@${expected.electronCommit}`,
      ],
      { cwd: root, env: toolEnv },
    );
    await apply(expected);
    await run('gclient', ['runhooks'], { cwd: root, env: toolEnv });
    return;
  }
  if (command === 'build') {
    await requireToolchain();
    await verifyTools(expected);
    await apply(expected);
    await run('gn', ['gen', out, `--args=${gnArgs}`], { cwd: join(root, 'src'), env: toolEnv });
    await run('autoninja', ['-C', out, 'electron', 'electron:electron_dist_zip'], {
      cwd: join(root, 'src'),
      env: toolEnv,
    });
    return;
  }
  if (command === 'verify') {
    const binary = resolve(
      value(
        '--binary',
        join(
          root,
          'src',
          out,
          process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
        ),
      ),
    );
    if (!['Electron', 'electron', 'electron.exe'].includes(basename(binary)))
      throw Error('Acceptance requires the generic Electron binary, never packaged Pilion');
    if (!(await lstat(binary)).isFile())
      throw Error('Native runtime binary must be a regular executable file');
    const sourceTree = await verifyPatchedSource(expected);
    const zip = await realpath(resolve(value('--zip', join(root, 'src', out, 'dist.zip'))));
    if (!(await lstat(zip)).isFile())
      throw Error('A distribution ZIP is required for native acceptance');
    const zipSha256 = await hashFile(zip);
    const binaryPath = await realpath(binary);
    const binarySha256 = await hashFile(binaryPath);
    const workspace = await mkdtemp(join(tmpdir(), 'pilion-native-acceptance-'));
    let passed = false;
    try {
      const extractedBinary = await extractRuntime(zip, join(workspace, 'runtime'));
      const extractedPath = await realpath(extractedBinary);
      const extractedSha256 = await hashFile(extractedPath);
      if (extractedSha256 !== binarySha256)
        throw Error('Distribution ZIP runtime does not match the requested binary SHA-256');
      const profile = join(workspace, 'profile');
      const fixture = join(source, 'spec/fixtures/extensions/user-scripts/main.js');
      const env = {
        ...baseEnv,
        NODE_ENV: 'test',
        PILION_E2E_NO_FOCUS: '1',
        PILION_INTEGRATION_HOME: join(profile, 'integration'),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const phases = [];
      for (const phase of ['register', 'restore', 'revoke', 'revoked']) {
        const stdout = await capture(
          extractedBinary,
          [fixture, profile, phase, `--user-data-dir=${profile}`],
          { env, timeout: 60000 },
        );
        phases.push(parseFixtureOutput(stdout, phase, expected, process.platform, arch));
      }
      // Detect a replaced artifact or executable before writing any pass receipt.
      if (
        (await hashFile(zip)) !== zipSha256 ||
        (await hashFile(binaryPath)) !== binarySha256 ||
        (await hashFile(extractedPath)) !== extractedSha256
      )
        throw Error('Runtime artifact changed during native acceptance');
      await verifyPatchedSource(expected);
      if ((await hashFile(expected.patch)) !== expected.patchSha256)
        throw Error('Native patch changed during acceptance');
      const receipt = {
        receiptVersion: 2,
        verifiedAt: new Date().toISOString(),
        electron: expected.electronTag,
        commit: expected.electronCommit,
        patchSha256: expected.patchSha256,
        source,
        sourceTree,
        platform: process.platform,
        arch,
        binary: binaryPath,
        binarySha256,
        zip,
        zipSha256,
        extractedBinary: extractedPath,
        extractedSha256,
        profile,
        phases,
        nativeFixture: 'passed',
        tampermonkey: 'not-yet-tested',
        provenance:
          'Artifact hashes and fixture-reported behavior; not an independent attestation of binary build provenance',
      };
      const receipts = join(root, 'receipts');
      await mkdir(receipts, { recursive: true });
      const path = join(receipts, `${process.platform}-${arch}.json`);
      await writeFile(path, JSON.stringify(receipt, null, 2) + '\n');
      passed = true;
      console.log('Native fixture receipt:', path);
    } finally {
      if (!passed) await rm(workspace, { recursive: true, force: true });
    }
    return;
  }
  throw Error(`Unknown command ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(json ? JSON.stringify({ ok: false, error: String(error) }) : String(error));
    process.exitCode = 1;
  });
