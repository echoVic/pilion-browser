// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserDataPanel } from '../src/renderer/BrowserDataPanel';
import { ExtensionsMenu } from '../src/renderer/ExtensionsMenu';

// 主进程抛出的错误经过 IPC 会被包一层英文前缀；界面上只该出现原因本身。
const wrapped = (method: string, reason: string) =>
  new Error(`Error invoking remote method '${method}': Error: ${reason}`);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'pilion');
  vi.unstubAllGlobals();
});
function stub(browserData: Record<string, unknown>) {
  Object.defineProperty(window, 'pilion', { configurable: true, value: { browserData } });
}

it('shows why the extensions menu could not load, without the IPC wrapper', async () => {
  stub({
    toolbarItems: vi.fn(async () => {
      throw wrapped('browser-data:toolbar-items', '扩展目录读不出来');
    }),
    onExtensionsChanged: () => () => {},
    toolbarAction: vi.fn(async () => {
      throw wrapped('browser-data:toolbar-action', '扩展已被移除');
    }),
  });
  await act(async () => root.render(createElement(ExtensionsMenu)));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('扩展目录读不出来');
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.extensions-menu-manage')!.click(),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('扩展已被移除');
});

it('shows why browser data sources could not load, without the IPC wrapper', async () => {
  stub({
    sources: vi.fn(async () => {
      throw wrapped('browser-data:sources', '没有找到可导入的浏览器');
    }),
    extensions: vi.fn(async () => []),
  });
  await act(async () => root.render(createElement(BrowserDataPanel)));
  expect(container.textContent).toContain('没有找到可导入的浏览器');
  expect(container.textContent).not.toContain('Error invoking remote method');
});
