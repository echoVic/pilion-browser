import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots: string[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(await readFile('runtime/electron/build-lock.json', 'utf8'));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(platform = 'darwin', arch = 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'pilion-package-'));
  roots.push(root);
  const dir = join(root, `${platform}-${arch}`);
  await mkdir(dir);
  const binaryName =
    platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : platform === 'win32'
        ? 'electron.exe'
        : 'electron';
  await exec('python3', [
    '-c',
    'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],b"native-runtime"); z.close()',
    join(dir, 'dist.zip'),
    binaryName,
  ]);
  const zipSha256 = createHash('sha256')
    .update(await readFile(join(dir, 'dist.zip')))
    .digest('hex');
  const evidence = {
    platform,
    arch,
    zipSha256,
    extensionId: 'dhdgffkkebhmkfjojejmpbldmpobfkfo',
    version: '5.5.1',
    packageSha256: 'a'.repeat(64),
    unmodified: true,
    checks: { domInjection: true, navigation: true, restart: true, revocation: true },
  };
  const receipt = {
    receiptVersion: 2,
    verifiedAt: '2026-11-06T01:00:00.000Z',
    sourceTree: 'b'.repeat(40),
    binarySha256: sha('native-runtime'),
    extractedSha256: sha('native-runtime'),
    phases: ['register', 'restore', 'revoke', 'revoked'].map((phase) => ({
      phase,
      injected: ['register', 'restore'].includes(phase),
      allowed: ['register', 'restore'].includes(phase),
      runtime: {
        electron: lock.electronTag.slice(1),
        chromium: lock.chromiumVersion,
        platform,
        arch,
      },
    })),
    electron: lock.electronTag,
    commit: lock.electronCommit,
    patchSha256: lock.patchSha256,
    platform,
    arch,
    nativeFixture: 'passed',
    tampermonkey: 'passed',
    zipSha256,
    tampermonkeyEvidence: {
      file: 'tampermonkey-acceptance.json',
      sha256: sha(JSON.stringify(evidence)),
    },
  };
  await writeFile(join(dir, 'tampermonkey-acceptance.json'), JSON.stringify(evidence));
  const save = () => writeFile(join(dir, 'receipt.json'), JSON.stringify(receipt));
  await save();
  return { root, dir, receipt, evidence, save };
}
async function packageRuntime(root: string | undefined, platform = 'darwin', arch = 3) {
  const code = `const {default: beforePack} = await import(${JSON.stringify(resolve('runtime/electron/packaging.mjs'))});
    const context = {electronPlatformName: ${JSON.stringify(platform)}, arch: ${arch}, packager: {config: {}}};
    await beforePack(context); console.log(context.packager.config.electronDist);`;
  const env = { ...process.env };
  delete env.PILION_ELECTRON_ARTIFACTS;
  if (root) env.PILION_ELECTRON_ARTIFACTS = root;
  return exec(process.execPath, ['--input-type=module', '-e', code], { env });
}
it('refuses stock Electron packaging without native artifacts', async () => {
  await expect(packageRuntime(undefined)).rejects.toThrow(/PILION_ELECTRON_ARTIFACTS/);
});
it.each([
  ['darwin', 'arm64', 3],
  ['darwin', 'x64', 1],
  ['win32', 'x64', 1],
  ['linux', 'x64', 1],
] as const)('selects only the verified zip for %s %s', async (platform, arch, numericArch) => {
  const f = await fixture(platform, arch);
  expect((await packageRuntime(f.root, platform, numericArch)).stdout.trim()).toBe(
    join(f.dir, 'dist.zip'),
  );
});
it('cannot reuse the previous architecture archive when the next architecture is missing', async () => {
  const f = await fixture();
  await expect(packageRuntime(f.root, 'darwin', 1)).rejects.toThrow(/receipt/);
});
it.each([
  ['electron', 'v1.0.0'],
  ['commit', '0'.repeat(40)],
  ['patchSha256', '0'.repeat(64)],
  ['platform', 'win32'],
  ['arch', 'x64'],
  ['nativeFixture', 'failed'],
  ['tampermonkey', 'not-yet-tested'],
  ['zipSha256', '0'.repeat(64)],
])('rejects an incompatible %s receipt', async (field, value) => {
  const f = await fixture();
  Object.assign(f.receipt, { [field]: value });
  await f.save();
  await expect(packageRuntime(f.root)).rejects.toThrow(/Native runtime/);
});
it('rejects bytes changed after native acceptance', async () => {
  const f = await fixture();
  await writeFile(join(f.dir, 'dist.zip'), 'stock-runtime');
  await expect(packageRuntime(f.root)).rejects.toThrow(/archive SHA-256/);
});
it('rejects edited acceptance evidence', async () => {
  const f = await fixture();
  await writeFile(join(f.dir, 'tampermonkey-acceptance.json'), '{}');
  await expect(packageRuntime(f.root)).rejects.toThrow(/evidence SHA-256/);
});
it.each(['unmodified', 'restart', 'zipSha256'])(
  'rejects hash-valid evidence missing real acceptance: %s',
  async (field) => {
    const f = await fixture();
    if (field === 'restart') f.evidence.checks.restart = false;
    else if (field === 'unmodified') f.evidence.unmodified = false;
    else f.evidence.zipSha256 = '0'.repeat(64);
    const bytes = JSON.stringify(f.evidence);
    await writeFile(join(f.dir, 'tampermonkey-acceptance.json'), bytes);
    f.receipt.tampermonkeyEvidence.sha256 = sha(bytes);
    await f.save();
    await expect(packageRuntime(f.root)).rejects.toThrow(/Tampermonkey acceptance/);
  },
);
it('rejects unsupported packager architecture instead of selecting the host runtime', async () => {
  const f = await fixture();
  await expect(packageRuntime(f.root, 'darwin', 4)).rejects.toThrow(
    /Unsupported native runtime target/,
  );
});

it.each([
  'receiptVersion',
  'verifiedAt',
  'sourceTree',
  'binarySha256',
  'extractedSha256',
  'phases',
])('rejects a legacy or incomplete native proof missing %s', async (field) => {
  const f = await fixture();
  const receipt = { ...f.receipt } as Record<string, unknown>;
  delete receipt[field];
  await writeFile(join(f.dir, 'receipt.json'), JSON.stringify(receipt));
  await expect(packageRuntime(f.root)).rejects.toThrow(/Native runtime/);
});
it('rejects claimed executable hashes that do not match the archive executable', async () => {
  const f = await fixture();
  f.receipt.binarySha256 = f.receipt.extractedSha256 = '0'.repeat(64);
  await f.save();
  await expect(packageRuntime(f.root)).rejects.toThrow(/executable SHA-256/);
});
it.each(['injected', 'chromium', 'arch', 'duplicate'])(
  'rejects invalid perphase runtime proof: %s',
  async (field) => {
    const f = await fixture();
    if (field === 'injected') f.receipt.phases[2].injected = true;
    else if (field === 'duplicate') f.receipt.phases[3] = f.receipt.phases[0];
    else f.receipt.phases[0].runtime[field as 'chromium' | 'arch'] = 'wrong';
    await f.save();
    await expect(packageRuntime(f.root)).rejects.toThrow(/phase proof/);
  },
);
