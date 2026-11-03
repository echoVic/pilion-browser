import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, it } from 'vitest';
import type { AgentIntegrationView } from '../src/shared/contracts';

const text = readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const section = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'AgentIntegrationSection',
)!;
const context: Record<string, unknown> = { exports: {}, require: createRequire(import.meta.url) };
runInNewContext(
  ts.transpileModule(section.getText(source), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  context,
);
const Section = context.AgentIntegrationSection as ComponentType<{
  view: AgentIntegrationView | undefined;
  busy: boolean;
  onInstall(): void;
  onRemove(): void;
}>;

const base: AgentIntegrationView = {
  supported: true,
  installed: false,
  shimPath: '/Users/u/.local/bin/pilion',
  shimConflict: false,
  pathHasShimDir: true,
  targets: [
    { agent: 'Claude Code', path: '/Users/u/.claude/skills/pilion-browser', status: 'installed' },
    { agent: 'Codex', path: '/Users/u/.codex/skills/pilion-browser', status: 'skipped-foreign' },
  ],
};
const render = (view: AgentIntegrationView | undefined, busy = false) =>
  renderToStaticMarkup(createElement(Section, { view, busy, onInstall() {}, onRemove() {} }));

it('offers install with the targets it will write and the credential warning', () => {
  const html = render(base);
  expect(html).toContain('安装到 Agent');
  expect(html).toContain('Claude Code');
  expect(html).toContain('已有同名 skill，跳过');
  expect(html).toContain('cli.token');
  expect(html).not.toMatch(/<button[^>]*>移除<\/button>/);
});

it('shows installed state with remove and the PATH hint when needed', () => {
  const html = render({ ...base, installed: true, clientId: 'c1', pathHasShimDir: false });
  expect(html).toContain('重新安装');
  expect(html).toContain('移除');
  expect(html).toContain('export PATH=&quot;$HOME/.local/bin:$PATH&quot;');
});

it('blocks install on a foreign shim', () => {
  const html = render({ ...base, shimConflict: true });
  expect(html).toContain('不是 Pilion 生成的');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>安装到 Agent/);
});

it('renders nothing when unsupported and a placeholder while loading', () => {
  expect(render({ ...base, supported: false })).toBe('');
  expect(render(undefined)).toContain('正在读取');
});

it('shows a deleted copy as not installed instead of a check mark', () => {
  const html = render({
    ...base,
    installed: true,
    clientId: 'c1',
    targets: [
      { agent: 'Claude Code', path: '/Users/u/.claude/skills/pilion-browser', status: 'missing' },
      { agent: 'Codex', path: '/Users/u/.codex/skills/pilion-browser', status: 'installed' },
    ],
  });
  expect(html).toContain('Claude Code（未安装：已被删除，重新安装可补回）');
  expect(html).not.toContain('Claude Code ✓');
  expect(html).toContain('Codex ✓');
});
