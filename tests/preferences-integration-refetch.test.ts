// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import type { ExternalClientView } from '../src/shared/contracts';

/** ExternalControlSection 原样从 Preferences.tsx 拿出来跑：集成状态只在客户端真变化时重读。 */
// happy-dom 环境下 import.meta.url 不是 file: URL，按仓库根目录（vitest 的 cwd）定位源码。
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
const status = vi.fn(async () => ({
  supported: true,
  installed: false,
  shimPath: '/h/.local/bin/pilion',
  shimConflict: false,
  pathHasShimDir: true,
  targets: [],
}));
const context: Record<string, unknown> = {
  exports: {},
  require: createRequire(join(process.cwd(), 'package.json')),
  Switch: () => null,
  navigator: { userAgent: 'Macintosh' },
  window: { pilion: { external: { integration: { status } } } },
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

const client = (revokedAt?: string): ExternalClientView => ({
  clientId: 'c1',
  name: 'n',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: '2026-11-01T00:00:00.000Z',
  ...(revokedAt ? { revokedAt } : {}),
});

it('re-reads the integration status only when the clients actually change', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div'));
  const render = (clients: ExternalClientView[]) =>
    act(async () => {
      root.render(
        createElement(Section, {
          settings: { externalControl: true },
          external: { connections: [], clients, onCreated() {} },
          save() {},
          run: async () => true,
        }),
      );
    });
  await render([client()]);
  expect(status).toHaveBeenCalledTimes(1);
  // 每次 state 推送都是新数组、内容相同：不该再发 IPC。
  await render([client()]);
  await render([client()]);
  expect(status).toHaveBeenCalledTimes(1);
  // 被吊销了：要重读（可能触发 onClientGone 清理）。
  await render([client('2026-11-02T00:00:00.000Z')]);
  expect(status).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});
