// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

/** ExternalControlSection 原样从 Preferences.tsx 拿出来跑：签发客户端失败要走 run，让人看到原因。 */
const text = readFileSync(join(process.cwd(), 'src/renderer/Preferences.tsx'), 'utf8');
const source = ts.createSourceFile(
  'Preferences.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const wanted = ['ExternalControlSection', 'AgentIntegrationSection'];
const code = source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text ?? ''))
  .map((node) => node.getText(source))
  .join('\n');
const createClient = vi.fn<(name: string) => Promise<never>>(async () => {
  throw new Error("Error invoking remote method 'external:create-client': Error: 名称已被占用");
});
const context: Record<string, unknown> = {
  exports: {},
  require: createRequire(join(process.cwd(), 'package.json')),
  Switch: () => null,
  navigator: { userAgent: 'Macintosh' },
  window: {
    pilion: {
      external: {
        createClient,
        integration: { status: vi.fn(async () => new Promise(() => {})) },
      },
    },
  },
};
runInNewContext(
  `const { useEffect, useState } = require('react');\n${
    ts.transpileModule(code, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
  }\nexports.Section = ExternalControlSection;`,
  context,
);
const Section = (context.exports as { Section: ComponentType<Record<string, unknown>> }).Section;

it('reports a failed client creation through run instead of swallowing it', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const failures: unknown[] = [];
  const run = vi.fn(async (action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (cause) {
      failures.push(cause);
      return false;
    }
  });
  await act(async () => {
    root.render(
      createElement(Section, {
        settings: { externalControl: true },
        external: { connections: [], clients: [], onCreated: vi.fn() },
        save() {},
        run,
      }),
    );
  });
  const input = container.querySelector<HTMLInputElement>('.external-create-row input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'claude-desktop',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = container.querySelector<HTMLButtonElement>('.external-create-row button')!;
  await act(async () => button.click());
  expect(createClient).toHaveBeenCalledWith('claude-desktop');
  expect(failures).toHaveLength(1);
  // 名字留着，人改一下就能重试；按钮也回到可点。
  expect(input.value).toBe('claude-desktop');
  expect(button.disabled).toBe(false);
  expect(button.textContent).toBe('新增客户端');
  await act(async () => root.unmount());
});
