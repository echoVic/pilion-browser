import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const digest = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const requireValue = (condition, message) => {
  if (!condition) throw Error(`Native runtime: ${message}`);
};
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// beforePack throws propagate. An electronDist function is unsafe: electron-builder
// catches its errors and falls back to stock Electron (app-builder-lib 26.16.1).
export default async function beforePack(context) {
  const root = process.env.PILION_ELECTRON_ARTIFACTS;
  requireValue(root, 'PILION_ELECTRON_ARTIFACTS must point to verified native artifacts');
  const platform = context.electronPlatformName;
  // builder-util Arch numeric enum, NOT process.arch (cross packaging is supported).
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  requireValue(
    ['darwin', 'win32', 'linux'].includes(platform) && arch,
    'Unsupported native runtime target',
  );
  requireValue(
    !(context.packager.config.concurrency?.jobs > 1),
    'architecture packaging must be serial (concurrency.jobs: 1)',
  );
  const lock = await json(join(here, 'build-lock.json'));
  const patchPath = resolve(here, lock.patch);
  const patchRelative = relative(here, patchPath);
  requireValue(
    !isAbsolute(patchRelative) && !patchRelative.startsWith('..'),
    'patch must be inside runtime/electron',
  );
  requireValue((await digest(patchPath)) === lock.patchSha256, 'patch SHA-256 mismatch');
  const version = lock.electronTag.replace(/^v/, '');
  const pkg = await json(join(here, '../../package.json'));
  requireValue(
    pkg.devDependencies.electron === version,
    'Electron package version differs from lock',
  );
  if (context.packager.info?.framework?.version) {
    requireValue(
      context.packager.info.framework.version === version,
      'packager Electron version differs from lock',
    );
  }
  const dir = resolve(root, `${platform}-${arch}`);
  const archive = join(dir, 'dist.zip');
  const receipt = await json(join(dir, 'receipt.json'));
  for (const [field, expected] of Object.entries({
    electron: lock.electronTag,
    commit: lock.electronCommit,
    patchSha256: lock.patchSha256,
    platform,
    arch,
    nativeFixture: 'passed',
    tampermonkey: 'passed',
  })) {
    requireValue(receipt[field] === expected, `receipt ${field} must be ${expected}`);
  }
  requireValue(receipt.receiptVersion === 2, 'receiptVersion 2 native proof required');
  requireValue(
    typeof receipt.verifiedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(receipt.verifiedAt) &&
      Number.isFinite(Date.parse(receipt.verifiedAt)),
    'native verification timestamp required',
  );
  requireValue(
    typeof receipt.sourceTree === 'string' && /^[a-f0-9]{40}$/.test(receipt.sourceTree),
    'exact patched source tree proof required',
  );
  requireValue(
    sha256(receipt.binarySha256) && receipt.extractedSha256 === receipt.binarySha256,
    'matching requested and extracted executable SHA-256 proof required',
  );
  const phases = ['register', 'restore', 'revoke', 'revoked'];
  requireValue(
    Array.isArray(receipt.phases) && receipt.phases.length === phases.length,
    'four native phase proofs required',
  );
  for (const [index, phase] of phases.entries()) {
    const marker = receipt.phases[index];
    const enabled = index < 2;
    requireValue(
      marker?.phase === phase &&
        marker.injected === enabled &&
        marker.allowed === enabled &&
        marker.runtime?.electron === version &&
        marker.runtime.chromium === lock.chromiumVersion &&
        marker.runtime.platform === platform &&
        marker.runtime.arch === arch,
      `invalid native phase proof for ${phase}`,
    );
  }
  requireValue(sha256(receipt.zipSha256), 'receipt archive SHA-256 required');
  requireValue((await digest(archive)) === receipt.zipSha256, 'archive SHA-256 mismatch');
  // Check the actual ZIP member without requiring paths on the original build machine.
  const executable =
    platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : platform === 'win32'
        ? 'electron.exe'
        : 'electron';
  const { stdout: executableHash } = await exec(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      `
import hashlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    members = [entry for entry in archive.infolist() if entry.filename == sys.argv[2]]
    if len(members) != 1 or members[0].is_dir():
        raise ValueError('Native runtime executable ZIP member missing or duplicated')
    digest = hashlib.sha256()
    with archive.open(members[0]) as executable:
        for chunk in iter(lambda: executable.read(1024 * 1024), b''):
            digest.update(chunk)
    print(digest.hexdigest())
`,
      archive,
      executable,
    ],
  );
  requireValue(
    executableHash.trim() === receipt.extractedSha256,
    'archive executable SHA-256 mismatch',
  );
  const evidenceRef = receipt.tampermonkeyEvidence;
  requireValue(
    evidenceRef?.file === 'tampermonkey-acceptance.json' && sha256(evidenceRef.sha256),
    'Tampermonkey acceptance evidence reference required',
  );
  const evidencePath = join(dir, evidenceRef.file);
  requireValue((await digest(evidencePath)) === evidenceRef.sha256, 'evidence SHA-256 mismatch');
  const evidence = await json(evidencePath);
  requireValue(
    evidence.platform === platform &&
      evidence.arch === arch &&
      evidence.zipSha256 === receipt.zipSha256 &&
      evidence.extensionId === 'dhdgffkkebhmkfjojejmpbldmpobfkfo' &&
      typeof evidence.version === 'string' &&
      /^\d+\.\d+(?:\.\d+)*$/.test(evidence.version) &&
      sha256(evidence.packageSha256) &&
      evidence.unmodified === true &&
      ['domInjection', 'navigation', 'restart', 'revocation'].every(
        (check) => evidence.checks?.[check] === true,
      ),
    'Tampermonkey acceptance must prove original package and all checks on this archive',
  );
  // Absolute zip STRING takes the strict upstream path; never use a resolver hook.
  context.packager.config.electronDist = archive;
}
