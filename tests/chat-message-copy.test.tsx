// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COPIED_RESET_MS, CopyReplyButton } from '../src/renderer/ChatMessage';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const label = () => container.querySelector('button')?.getAttribute('aria-label');

it('shows 已复制 briefly and then offers to copy again', async () => {
  const copy = vi.fn(async () => {});
  await act(async () => root.render(createElement(CopyReplyButton, { copy })));
  await act(async () => container.querySelector('button')!.click());
  expect(label()).toBe('已复制');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COPIED_RESET_MS);
  });
  expect(label()).toBe('复制回复');
});

it('reports a failed copy and clears it after a successful retry', async () => {
  const copy = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('denied'));
  copy.mockResolvedValueOnce();
  await act(async () => root.render(createElement(CopyReplyButton, { copy })));
  await act(async () => container.querySelector('button')!.click());
  expect(label()).toBe('复制失败，重试');
  await act(async () => container.querySelector('button')!.click());
  expect(label()).toBe('已复制');
});
