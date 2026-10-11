import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import type { DefaultBrowserStatus } from '../src/shared/contracts';
import { observeDefaultBrowser } from '../src/renderer/default-browser';

afterEach(() => vi.useRealTimers());

function observer() {
  vi.useFakeTimers();
  let status = { supported: true, isDefault: false };
  const seen: DefaultBrowserStatus[] = [];
  const errors: unknown[] = [];
  const api = {
    get: vi.fn(async () => status),
    set: vi.fn(async () => status),
  };
  const focus = new EventTarget();
  const watching = observeDefaultBrowser(
    api,
    (next) => seen.push(next),
    async (action) => {
      try {
        await action();
        return true;
      } catch (error) {
        errors.push(error);
        return false;
      }
    },
    focus,
  );
  return {
    api,
    seen,
    errors,
    focus,
    watching,
    setStatus: (next: DefaultBrowserStatus) => {
      status = next;
    },
  };
}

it('queries on mount and settings focus without polling before a request', async () => {
  const { watching, seen, api, focus, setStatus } = observer();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([{ supported: true, isDefault: false }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.get).toHaveBeenCalledOnce();
  setStatus({ supported: true, isDefault: true });
  focus.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.at(-1)).toEqual({ supported: true, isDefault: true });
  watching.dispose();
});

it('refreshes after requesting and polls for 20 seconds while the person answers the system dialog', async () => {
  const { watching, seen, api, setStatus } = observer();
  await vi.advanceTimersByTimeAsync(0);
  expect(await watching.request()).toBe(true);
  expect(api.set).toHaveBeenCalledOnce();
  expect(seen.at(-1)?.isDefault).toBe(false);
  await vi.advanceTimersByTimeAsync(19_000);
  setStatus({ supported: true, isDefault: true });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(seen.at(-1)?.isDefault).toBe(true);
  const queries = api.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(40_000);
  expect(api.get).toHaveBeenCalledTimes(queries);
  watching.dispose();
});

it('restarts the polling window on another request and disposes timers and focus listeners', async () => {
  const { watching, api, focus } = observer();
  await watching.request();
  await vi.advanceTimersByTimeAsync(19_000);
  await watching.request();
  const queries = api.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(api.get).toHaveBeenCalledTimes(queries + 2);
  watching.dispose();
  const stopped = api.get.mock.calls.length;
  focus.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.get).toHaveBeenCalledTimes(stopped);
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores stale queries and pending results after disposal', async () => {
  const { watching, api, seen, focus } = observer();
  await vi.advanceTimersByTimeAsync(0);
  let finish!: (value: DefaultBrowserStatus) => void;
  api.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  focus.dispatchEvent(new Event('focus'));
  api.set.mockResolvedValueOnce({ supported: true, isDefault: true });
  await watching.request();
  finish({ supported: true, isDefault: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.at(-1)?.isDefault).toBe(true);
  api.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  focus.dispatchEvent(new Event('focus'));
  watching.dispose();
  const count = seen.length;
  finish({ supported: true, isDefault: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toHaveLength(count);
});

it('ends polling after 20 elapsed seconds even when timers are delayed while the window is inactive', async () => {
  const { watching, api } = observer();
  await watching.request();
  vi.setSystemTime(Date.now() + 60_000);
  await vi.advanceTimersByTimeAsync(1_000);
  const queries = api.get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(api.get).toHaveBeenCalledTimes(queries);
  watching.dispose();
});

it('reports IPC errors through the settings error handler and remains refreshable', async () => {
  const { watching, api, errors, seen, focus } = observer();
  await vi.advanceTimersByTimeAsync(0);
  const error = new Error('系统请求失败');
  api.set.mockRejectedValueOnce(error);
  expect(await watching.request()).toBe(false);
  expect(errors).toEqual([error]);
  focus.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.at(-1)).toEqual({ supported: true, isDefault: false });
  watching.dispose();
});

function renderRow(status?: DefaultBrowserStatus) {
  const source = ts.createSourceFile(
    'Preferences.tsx',
    readFileSync(new URL('../src/renderer/Preferences.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const row = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'DefaultBrowserRow',
  );
  expect(row).toBeDefined();
  const context: Record<string, unknown> = { exports: {}, require: createRequire(import.meta.url) };
  runInNewContext(
    ts.transpileModule(row!.getText(source), {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  const Row = context.DefaultBrowserRow as ComponentType<{
    status?: DefaultBrowserStatus;
    onSet(): void;
  }>;
  return renderToStaticMarkup(createElement(Row, { status, onSet() {} }));
}

it('hides the row before status arrives and for unsupported builds', () => {
  expect(renderRow()).toBe('');
  expect(renderRow({ supported: false, isDefault: false })).toBe('');
});

it('shows a request button until Pilion is default, then shows status without a button', () => {
  const available = renderRow({ supported: true, isDefault: false });
  expect(available).toContain('默认浏览器');
  expect(available).toMatch(/<button[^>]*>设为默认浏览器<\/button>/);
  const selected = renderRow({ supported: true, isDefault: true });
  expect(selected).toContain('Pilion 是默认浏览器');
  expect(selected).not.toContain('<button');
});
