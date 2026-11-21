import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const script = resolve('runtime/electron/build.mjs');
it('pins the native build plan without fetching sources or using paid remote execution', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pilion-build-plan-'));
  const root = join(parent, 'not-created');
  try {
    const { stdout } = await exec(process.execPath, [
      script,
      'plan',
      '--root',
      root,
      '--arch',
      'arm64',
      '--json',
    ]);
    const plan = JSON.parse(stdout);
    expect(
      plan.commands.find((row: string[]) => row[0] === 'gclient' && row[1] === 'sync'),
    ).toContain('--revision=src/electron@c41115bbafc47647b80a9a9f6f298392330eff88');
    expect(plan.commands.find((row: string[]) => row[0] === 'gn').join(' ')).toContain(
      'use_remoteexec=false',
    );
    await expect(stat(root)).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
it('rejects a tampered native patch before executing git or build tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pilion-build-lock-'));
  try {
    const lock = JSON.parse(await readFile(resolve('runtime/electron/build-lock.json'), 'utf8'));
    lock.patch = 'bad.patch';
    await writeFile(join(root, 'bad.patch'), 'tampered');
    await writeFile(join(root, 'lock.json'), JSON.stringify(lock));
    await expect(
      exec(process.execPath, [script, 'validate', '--lock', join(root, 'lock.json'), '--json']),
    ).rejects.toThrow(/SHA-256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('refuses a packaged browser binary before any native acceptance launch or profile write', async () => {
  await expect(
    exec(process.execPath, [
      script,
      'verify',
      '--binary',
      '/tmp/Pilion.app/Contents/MacOS/Pilion',
      '--json',
    ]),
  ).rejects.toThrow(/generic Electron binary/);
});
it('refuses build roots whose source path is somewhere else', async () => {
  await expect(
    exec(process.execPath, [
      script,
      'plan',
      '--root',
      '/tmp/build-root',
      '--source',
      '/tmp/another-checkout',
      '--json',
    ]),
  ).rejects.toThrow(/ROOT\/src\/electron/);
});

async function verificationCase() {
  const dir = await mkdtemp(join(tmpdir(), 'pilion-runtime-verify-'));
  const source = join(dir, 'source');
  await mkdir(join(source, 'spec/fixtures/extensions/user-scripts'), { recursive: true });
  await writeFile(join(source, 'DEPS'), 'chromium_version = "150.0.7871.250"\n');
  await writeFile(join(source, 'native-state.txt'), 'off\n');
  await writeFile(
    join(source, 'spec/fixtures/extensions/user-scripts/main.js'),
    '// native fixture\n',
  );
  await exec('git', ['init', '-q'], { cwd: source });
  await exec('git', ['add', '.'], { cwd: source });
  const { stdout: tree } = await exec('git', ['write-tree'], { cwd: source });
  const { stdout: commit } = await exec(
    'git',
    ['commit-tree', tree.trim(), '-m', 'temporary test fixture'],
    {
      cwd: source,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    },
  );
  await exec('git', ['update-ref', 'HEAD', commit.trim()], { cwd: source });
  await writeFile(join(source, 'native-state.txt'), 'on\n');
  const { stdout: patch } = await exec('git', ['diff', '--binary', 'HEAD'], { cwd: source });
  const { createHash } = await import('node:crypto');
  const lock = JSON.parse(await readFile(resolve('runtime/electron/build-lock.json'), 'utf8'));
  lock.electronCommit = commit.trim();
  lock.patch = 'native.patch';
  lock.patchSha256 = createHash('sha256').update(patch).digest('hex');
  await writeFile(join(dir, lock.patch), patch);
  await writeFile(join(dir, 'lock.json'), JSON.stringify(lock));
  const binary = join(dir, 'electron');
  await symlink('/usr/bin/true', binary);
  const zip = join(dir, 'runtime.zip');
  const member =
    process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  await exec('python3', [
    '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo(sys.argv[3]); i.external_attr=0o100755<<16; z.writestr(i,open(sys.argv[2],"rb").read()); z.close()',
    zip,
    binary,
    member,
  ]);
  const args = [
    script,
    'verify',
    '--root',
    join(dir, 'build'),
    '--source',
    source,
    '--lock',
    join(dir, 'lock.json'),
    '--binary',
    binary,
    '--zip',
    zip,
    '--arch',
    process.arch,
    '--json',
  ];
  return { dir, source, binary, zip, args };
}

it.skipIf(process.platform === 'win32')(
  'starts the native fixture from the Windows archive member',
  async () => {
    const fixture = await verificationCase();
    try {
      const binary = join(fixture.dir, 'electron.exe');
      await copyFile(fixture.binary, binary);
      await exec('python3', [
        '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo("electron.exe"); i.external_attr=0o100755<<16; z.writestr(i,open(sys.argv[2],"rb").read()); z.close()',
        fixture.zip,
        binary,
      ]);
      const python = join(fixture.dir, 'python');
      await writeFile(python, '#!/bin/sh\nexec python3 "$@"\n', { mode: 0o755 });
      const mockPlatform =
        "data:text/javascript,Object.defineProperty(process,'platform',{value:'win32'})";
      const args = fixture.args.filter((arg) => arg !== '--binary' && arg !== fixture.binary);
      await mkdir(join(fixture.dir, 'build/src/out', `Pilion-${process.arch}`), {
        recursive: true,
      });
      await copyFile(
        binary,
        join(fixture.dir, 'build/src/out', `Pilion-${process.arch}`, 'electron.exe'),
      );
      await expect(
        exec(process.execPath, ['--import', mockPlatform, ...args], {
          env: { ...process.env, TEMP: fixture.dir, PATH: `${fixture.dir}:${process.env.PATH}` },
        }),
      ).rejects.toThrow(/phase marker/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'never marks a symlink to true as a passing native fixture',
  async () => {
    const fixture = await verificationCase();
    try {
      await expect(exec(process.execPath, fixture.args)).rejects.toThrow();
      await expect(
        stat(join(fixture.dir, 'build/receipts', `${process.platform}-${process.arch}.json`)),
      ).rejects.toThrow();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects a zero-exit regular executable that emits no native phase evidence',
  async () => {
    const fixture = await verificationCase();
    try {
      await unlink(fixture.binary);
      await writeFile(fixture.binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const member =
        process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
      await exec('python3', [
        '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); i=zipfile.ZipInfo(sys.argv[3]); i.external_attr=0o100755<<16; z.writestr(i,open(sys.argv[2],"rb").read()); z.close()',
        fixture.zip,
        fixture.binary,
        member,
      ]);
      await expect(exec(process.execPath, fixture.args)).rejects.toThrow(
        /exactly one phase marker/,
      );
      await expect(
        stat(join(fixture.dir, 'build/receipts', `${process.platform}-${process.arch}.json`)),
      ).rejects.toThrow();
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects missing or unrelated native source changes before acceptance',
  async () => {
    const fixture = await verificationCase();
    try {
      await unlink(fixture.binary);
      await copyFile('/usr/bin/true', fixture.binary);
      await writeFile(join(fixture.source, 'native-state.txt'), 'off\n');
      await expect(exec(process.execPath, fixture.args)).rejects.toThrow(
        /exactly the pinned native patch/,
      );
      await writeFile(join(fixture.source, 'native-state.txt'), 'on\n');
      await writeFile(join(fixture.source, 'unrelated.txt'), 'unexpected source change');
      await expect(exec(process.execPath, fixture.args)).rejects.toThrow(
        /exactly the pinned native patch/,
      );
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects a stale archive whose executable differs from the requested runtime',
  async () => {
    const fixture = await verificationCase();
    try {
      await unlink(fixture.binary);
      await copyFile('/usr/bin/true', fixture.binary);
      const member =
        process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
      await exec('python3', [
        '-c',
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],"unrelated runtime"); z.close()',
        fixture.zip,
        member,
      ]);
      await expect(exec(process.execPath, fixture.args)).rejects.toThrow(/does not match.*SHA-256/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  },
);

it('requires each phase behavior marker and exact self-reported runtime identity', async () => {
  const { parseFixtureOutput } = await import(script);
  const expected = { electronTag: 'v43.7.9', chromiumVersion: '150.0.7871.250' };
  const runtime = {
    electron: '43.7.9',
    chromium: expected.chromiumVersion,
    platform: process.platform,
    arch: process.arch,
  };
  for (const phase of ['register', 'restore', 'revoke', 'revoked']) {
    const enabled = ['register', 'restore'].includes(phase);
    const marker = { phase, injected: enabled, allowed: enabled, runtime };
    expect(
      parseFixtureOutput(JSON.stringify(marker), phase, expected, process.platform, process.arch),
    ).toEqual(marker);
    expect(() => parseFixtureOutput('', phase, expected, process.platform, process.arch)).toThrow(
      /phase marker/,
    );
    expect(() =>
      parseFixtureOutput(
        JSON.stringify({ ...marker, injected: !enabled }),
        phase,
        expected,
        process.platform,
        process.arch,
      ),
    ).toThrow(/invalid behavior/);
    expect(() =>
      parseFixtureOutput(
        JSON.stringify({ ...marker, runtime: undefined }),
        phase,
        expected,
        process.platform,
        process.arch,
      ),
    ).toThrow(/runtime identity/);
    expect(() =>
      parseFixtureOutput(
        JSON.stringify({ ...marker, runtime: { ...runtime, electron: '1.0.0' } }),
        phase,
        expected,
        process.platform,
        process.arch,
      ),
    ).toThrow(/runtime identity/);
    expect(() =>
      parseFixtureOutput(
        JSON.stringify({ ...marker, runtime: { ...runtime, arch: 'wrong' } }),
        phase,
        expected,
        process.platform,
        process.arch,
      ),
    ).toThrow(/runtime identity/);
    expect(() =>
      parseFixtureOutput(
        JSON.stringify(marker) + '\n' + JSON.stringify(marker),
        phase,
        expected,
        process.platform,
        process.arch,
      ),
    ).toThrow(/exactly one/);
  }
});
