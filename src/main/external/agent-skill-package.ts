import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Bootstrap releases use stable major.minor.patch versions. Unknown formats
// (including future prereleases) cannot authorize replacing an installed copy.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareSkillVersions(left: string, right: string): number | undefined {
  if (!RELEASE_VERSION.test(left) || !RELEASE_VERSION.test(right)) return undefined;
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** Read the canonical metadata block used by our bootstrap, not arbitrary YAML. */
export async function readSkillVersion(dir: string): Promise<string | undefined> {
  const path = join(dir, 'SKILL.md');
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const text = await readFile(path, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replaceAll('\r\n', '\n'))?.[1];
  if (!frontmatter) return undefined;
  if ((frontmatter.match(/^metadata:/gm) ?? []).length !== 1) return undefined;
  const metadata = /^metadata:[ \t]*\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(frontmatter)?.[1];
  if (!metadata) return undefined;
  const versions = metadata.split('\n').filter((line) => /^ {2}version:/.test(line));
  if (versions.length !== 1) return undefined;
  const match = /^ {2}version:[ \t]*(?:'([^']+)'|"([^"]+)"|([^\s#]+))(?:[ \t]+#.*)?[ \t]*$/.exec(
    versions[0],
  );
  const version = match?.[1] ?? match?.[2] ?? match?.[3];
  return version && RELEASE_VERSION.test(version) ? version : undefined;
}
