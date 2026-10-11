import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, it } from 'vitest';
import type { UpdateStatus } from '../src/shared/contracts';
import * as updateView from '../src/renderer/update-view';

const text = readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const section = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'UpdateSection',
)!;
const context: Record<string, unknown> = {
  ...updateView,
  exports: {},
  require: createRequire(import.meta.url),
};
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
const UpdateSection = context.UpdateSection as ComponentType<{
  settings: { autoUpdate: boolean };
  update: { currentVersion: string; status: UpdateStatus };
  save(): void;
  run(): Promise<boolean>;
}>;

function render(status: UpdateStatus) {
  const html = renderToStaticMarkup(
    createElement(UpdateSection, {
      settings: { autoUpdate: true },
      update: { currentVersion: '0.1.9', status },
      save() {},
      async run() {
        return true;
      },
    }),
  );
  const live = html.match(/<span\b[^>]*role="status"[^>]*>(.*?)<\/span>/)?.[1];
  expect(live).toBeDefined();
  return { html, live };
}

it('keeps the live announcement unchanged across progress ticks while visible progress advances', () => {
  const first = render({ kind: 'downloading', version: '0.2.0', percent: 10 });
  const next = render({ kind: 'downloading', version: '0.2.0', percent: 55 });
  expect(first.live).toBe('正在下载更新');
  expect(next.live).toBe(first.live);
  expect(first.html).toContain('正在下载 0.2.0（10%）');
  expect(next.html).toContain('正在下载 0.2.0（55%）');
  expect(next.html).toMatch(/class="visually-hidden"[^>]*role="status"/);
  expect(render({ kind: 'downloaded', version: '0.2.0' }).live).toBe('更新已下载，退出时安装');
});

it('announces an error kind once while keeping its changing details visible', () => {
  const first = render({ kind: 'error', message: '无法连接到 GitHub', at: 1 });
  const next = render({ kind: 'error', message: '更新包校验失败', at: 2 });
  expect(first.live).toBe('更新失败，请查看详情');
  expect(next.live).toBe(first.live);
  expect(next.html).toContain('更新包校验失败');
  expect(render({ kind: 'checking' }).live).toBe('正在检查更新');
});
