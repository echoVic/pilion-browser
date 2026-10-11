import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, useState, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { AppSettingsSchema } from '../src/shared/settings';

const text = readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function render(custom = false, empty = false) {
  const section = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'BrowserPane',
  );
  expect(section, 'BrowserPane exists').toBeDefined();
  const context: Record<string, unknown> = {
    exports: {},
    require: createRequire(import.meta.url),
    useState: (initial: unknown) =>
      useState(
        empty && typeof initial === 'object'
          ? { history: false, downloads: false, cookies: false, cache: false }
          : initial,
      ),
  };
  runInNewContext(
    ts.transpileModule(section!.getText(source), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const BrowserPane = context.BrowserPane as ComponentType<{
    settings: ReturnType<typeof AppSettingsSchema.parse>;
    downloadLocation: string;
    run(): Promise<boolean>;
  }>;
  return renderToStaticMarkup(
    createElement(BrowserPane, {
      settings: AppSettingsSchema.parse(custom ? { downloadDirectory: '/home/q/downloads' } : {}),
      downloadLocation: '~/downloads',
      async run() {
        return true;
      },
    }),
  );
}

it('shows the download path and a reset button only for a custom location', () => {
  const html = render();
  expect(html).toContain('~/downloads');
  expect(html).toContain('更改…');
  expect(html).not.toContain('恢复默认');
  expect(render(true)).toContain('恢复默认');
});

it('defaults to history and cache, explains download list clearing and disables an empty selection', () => {
  const html = render();
  const labels = [...html.matchAll(/<label\b[^>]*>(.*?)<\/label>/g)].map((match) => match[1]);
  expect(labels).toHaveLength(4);
  expect(labels.filter((label) => label.includes('checked=""'))).toHaveLength(2);
  expect(labels.find((label) => label.includes('浏览记录'))).toContain('checked=""');
  expect(labels.find((label) => label.includes('缓存的图片和文件'))).toContain('checked=""');
  expect(labels.find((label) => label.includes('下载记录'))).toContain('不删除文件');
  expect(html).toContain('全部');
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>清除…/);
  expect(render(false, true)).toMatch(/<button[^>]*disabled=""[^>]*>清除…/);
});
