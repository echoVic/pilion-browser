// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppState } from '../src/shared/contracts';
import type { ScheduleRule } from '../src/shared/schedule';

/** SchedulesPane 原样从 Preferences.tsx 拿出来跑：预览一打开就取、旧回包不覆盖新规则，保存不重复提交。 */
const text = readFileSync(join(process.cwd(), 'src/renderer/Preferences.tsx'), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const functions = ['SchedulesPane', 'buildRule', 'formatWhen'];
const variables = ['WEEKDAY_OPTIONS'];
const code = source.statements
  .filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? '')) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) && variables.includes(declaration.name.text),
        )),
  )
  .map((node) => node.getText(source))
  .join('\n');
const preview = vi.fn<(rule: ScheduleRule) => Promise<string[]>>();
const save = vi.fn<(input: unknown) => Promise<{ id: string }>>();
const context: Record<string, unknown> = {
  exports: {},
  require: createRequire(join(process.cwd(), 'package.json')),
  Switch: () => null,
  TriangleAlert: () => null,
  describeRule: () => '规则',
  document,
  window: Object.assign(Object.create(window), {
    pilion: { schedules: { preview, save } },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    setTimeout,
    clearTimeout,
  }),
};
runInNewContext(
  `const { useEffect, useRef, useState } = require('react');\n${
    ts.transpileModule(code, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
  }\nexports.Pane = SchedulesPane;`,
  context,
);
const Pane = (context.exports as { Pane: ComponentType<Record<string, unknown>> }).Pane;

const state = {
  agents: [{ id: 'a1', name: 'Agent 一号' }],
  schedules: [],
} as unknown as AppState;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preview.mockReset();
  save.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const previewText = () =>
  [...container.querySelectorAll('p')].find((item) => item.textContent?.startsWith('接下来三次'))
    ?.textContent;
const saveButton = () =>
  [...container.querySelectorAll('button')].find((item) =>
    ['保存定时任务', '正在保存…'].includes(item.textContent ?? ''),
  )!;
async function mount(run = async (action: () => Promise<unknown>) => (await action(), true)) {
  await act(async () => root.render(createElement(Pane, { state, run })));
}

it('shows the next runs as soon as the pane opens', async () => {
  preview.mockResolvedValue(['2026-11-13T01:00:00.000Z']);
  await mount();
  expect(preview).toHaveBeenCalledWith({ kind: 'daily', time: '09:00' });
  expect(previewText()).toMatch(/^接下来三次：11月13日 \d\d:00$/);
});

it('ignores a preview that comes back after the rule has changed again', async () => {
  const pending: Array<(value: string[]) => void> = [];
  preview.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  await mount();
  const kind = container.querySelector<HTMLSelectElement>('#schedule-kind')!;
  await act(async () => {
    kind.value = 'interval';
    kind.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(preview).toHaveBeenLastCalledWith({ kind: 'interval', every: 30, unit: 'minute' });
  // 新规则的预览先回来，旧的「每天」预览后到：后到的那份不能盖上去。
  await act(async () => pending[1](['2026-11-13T02:30:00.000Z']));
  await act(async () => pending[0](['2026-11-20T01:00:00.000Z']));
  expect(previewText()).toContain('11月13日');
  expect(previewText()).not.toContain('11月20日');
});

it('saves once even when the button is pressed again while saving', async () => {
  preview.mockResolvedValue([]);
  let finish!: (value: { id: string }) => void;
  save.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await mount();
  const name = container.querySelector<HTMLInputElement>('#schedule-name')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '汇总');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    saveButton().click();
    saveButton().click();
  });
  expect(save).toHaveBeenCalledOnce();
  expect(saveButton().disabled).toBe(true);
  expect(saveButton().textContent).toBe('正在保存…');
  await act(async () => finish({ id: 's1' }));
  expect(saveButton().disabled).toBe(false);
  expect(saveButton().textContent).toBe('保存定时任务');
});
