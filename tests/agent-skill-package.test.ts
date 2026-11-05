import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  compareSkillVersions,
  readSkillVersion,
} from '../src/main/external/agent-skill-package.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pilion-skill-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it.each([
  ['1.0.0', '1.0.0', 0],
  ['1.10.0', '1.2.0', 1],
  ['1.2.0', '1.10.0', -1],
  ['1.0.10', '1.0.2', 1],
  ['2.0.0', '1.99.99', 1],
  ['0.2.1', '1.0.0', -1],
  ['1.0.0-beta', '1.0.0', undefined],
  ['01.0.0', '1.0.0', undefined],
  ['1.0.0', 'unknown', undefined],
])('compares stable skill releases %s and %s', (left, right, expected) => {
  expect(compareSkillVersions(left, right)).toBe(expected);
});

it.each(["'1.2.3'", '"1.2.3"', '1.2.3'])('reads metadata.version with %s', async (value) => {
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: pilion-browser\nmetadata:\n  version: ${value}\n---\nbody\n`,
  );
  expect(await readSkillVersion(dir)).toBe('1.2.3');
});

it('reads CRLF metadata without treating a top-level version as skill metadata', async () => {
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\r\nversion: 99.0.0\r\nmetadata:\r\n  version: "1.2.3"\r\n---\r\n',
  );
  expect(await readSkillVersion(dir)).toBe('1.2.3');
});

it.each([
  'body without frontmatter',
  '---\nversion: 99.0.0\n---\nmetadata:\n  version: 1.0.0\n',
  '---\nmetadata:\n  date: 2026-11-06\nother:\n  version: 99.0.0\n---\n',
  '---\nmetadata:\n  version: invalid\n---\n',
  '---\nmetadata:\n  version: 1.0.0#custom\n---\n',
  '---\nmetadata:\n  version: 1.0.0\n  version: 9.0.0\n---\n',
  '---\nmetadata:\n  version: 1.0.0\nmetadata:\n  version: 9.0.0\n---\n',
])('returns unknown for missing or unrecognized metadata %#', async (body) => {
  await writeFile(join(dir, 'SKILL.md'), body);
  expect(await readSkillVersion(dir)).toBeUndefined();
});

it('returns unknown for a missing, directory, or symlinked SKILL.md', async () => {
  expect(await readSkillVersion(dir)).toBeUndefined();
  await mkdir(join(dir, 'SKILL.md'));
  expect(await readSkillVersion(dir)).toBeUndefined();
  await rm(join(dir, 'SKILL.md'), { recursive: true });
  await writeFile(join(dir, 'elsewhere.md'), '---\nmetadata:\n  version: 1.0.0\n---\n');
  await symlink(join(dir, 'elsewhere.md'), join(dir, 'SKILL.md'));
  expect(await readSkillVersion(dir)).toBeUndefined();
});
