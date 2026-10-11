import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import clsx from 'clsx';
import * as icons from 'lucide-react';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as keybindings from '../src/shared/keybindings';

const text = readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

it('places the shortcuts navigation entry immediately before Agent', () => {
  const statements = source.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === 'PreferencesWindow') ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'PANES',
        )),
  );
  const context: Record<string, unknown> = {
    ...icons,
    clsx,
    useCallback,
    useEffect,
    useState,
    cachedTheme: () => 'light',
    navigator: { userAgent: 'Macintosh' },
    exports: {},
    require: createRequire(import.meta.url),
  };
  runInNewContext(
    ts.transpileModule(statements.map((node) => node.getText(source)).join('\n'), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const html = renderToStaticMarkup(createElement(context.PreferencesWindow as ComponentType));
  const labels = [...html.matchAll(/<button\b[^>]*>.*?<\/svg>(.*?)<\/button>/g)].map(
    (match) => match[1],
  );
  expect(labels.indexOf('快捷键')).toBeGreaterThan(labels.indexOf('通用'));
  expect(labels[labels.indexOf('快捷键') + 1]).toBe('Agent');
});

function render(mac: boolean) {
  const pane = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ShortcutsPane',
  );
  expect(pane, '设置窗口应提供只读快捷键页').toBeDefined();
  const context: Record<string, unknown> = {
    ...keybindings,
    Fragment,
    exports: {},
    require: createRequire(import.meta.url),
  };
  runInNewContext(
    ts.transpileModule(pane!.getText(source), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return renderToStaticMarkup(
    createElement(context.ShortcutsPane as ComponentType<{ mac: boolean }>, { mac }),
  );
}

it('renders one labelled read-only table per group with names, kbd keys and the footer', () => {
  const html = render(true);
  expect(html.match(/<table\b/g)).toHaveLength(4);
  for (const group of ['标签页', '导航', '页面', '其他']) {
    expect(html).toContain(`>${group}</h2>`);
    expect(html).toContain(`aria-labelledby="prefs-shortcuts-${group}"`);
  }
  expect(html).toContain('<th scope="row">新建标签页</th>');
  expect(html).toContain('<kbd>⌘T</kbd>');
  expect(html).toContain('<kbd>⌘L</kbd> / <kbd>⌘K</kbd>');
  expect(html).toContain('切换到第 1–8 个标签页');
  expect(html).not.toContain('切换到第 2 个标签页');
  expect(html).toContain('快捷键暂不支持修改。');
  expect(html).not.toMatch(/<(?:input|button|select|textarea)\b/);
});

it('renders Ctrl and Shift key names on Windows and Linux', () => {
  const html = render(false);
  expect(html).toContain('<kbd>Ctrl+T</kbd>');
  expect(html).toContain('<kbd>Ctrl+Shift+T</kbd>');
  expect(html).toContain('<kbd>Ctrl+L</kbd> / <kbd>Ctrl+K</kbd>');
  expect(html).not.toMatch(/[⌘⇧]/);
});
