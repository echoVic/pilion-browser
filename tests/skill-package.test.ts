import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^\s*([a-z_]+):\s*"?(.*?)"?\s*$/.exec(line);
    if (kv && kv[2]) out[kv[1]] = kv[2];
  }
  return out;
}

it('SKILL.md declares the pilion-browser name and the app version', () => {
  const fm = frontmatter(read('skills/pilion-browser/SKILL.md'));
  const pkg = JSON.parse(read('package.json')) as { version: string };
  expect(fm.name).toBe('pilion-browser');
  expect(fm.version).toBe(pkg.version);
  expect(fm.description.length).toBeGreaterThan(80);
});

it('SKILL.md bootstraps through `pilion skill` and names the sentinel', () => {
  const body = read('skills/pilion-browser/SKILL.md');
  expect(body).toContain('pilion skill');
  expect(body).toContain('[pilion:skill] end of guide');
  expect(body).toContain('references/install.md');
});

it('install.md covers the install button, PATH and status', () => {
  const body = read('skills/pilion-browser/references/install.md');
  expect(body).toContain('安装到 Agent');
  expect(body).toContain('$HOME/.local/bin');
  expect(body).toContain('pilion status');
  expect(body).toContain('Windows');
});

it.each(['.claude/skills/pilion-browser', '.agents/skills/pilion-browser'])(
  '%s is a symlink to skills/pilion-browser',
  (link) => {
    expect(lstatSync(new URL(link, root)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(new URL(link, root))).toBe('../../skills/pilion-browser');
  },
);
