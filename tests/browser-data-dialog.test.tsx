// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserDataDialog } from '../src/renderer/BrowserDataPanel';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'pilion', {
    configurable: true,
    value: {
      browserData: { sources: vi.fn(async () => []), extensions: vi.fn(async () => []) },
    },
  });
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

function Harness() {
  const [open, setOpen] = useState(false);
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, '扩展与浏览器数据'),
    createElement(BrowserDataDialog, { open, onOpenChange: setOpen }),
  );
}
const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');

it('behaves as a modal dialog: named, focus moves in, Esc closes and focus returns', async () => {
  await act(async () => root.render(createElement(Harness)));
  const opener = container.querySelector('button')!;
  opener.focus();
  await act(async () => opener.click());
  const opened = dialog();
  expect(opened).not.toBeNull();
  expect(opened!.getAttribute('aria-modal')).not.toBe('false');
  const titleId = opened!.getAttribute('aria-labelledby');
  expect(titleId && document.getElementById(titleId)?.textContent).toBe('扩展与浏览器数据');
  expect(opened!.contains(document.activeElement)).toBe(true);
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  expect(dialog()).toBeNull();
  // Radix 在下一拍把焦点还给打开它的按钮。
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement).toBe(opener);
});

it('closes from its own close button', async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => container.querySelector('button')!.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="关闭扩展管理"]')!.click(),
  );
  expect(dialog()).toBeNull();
});
