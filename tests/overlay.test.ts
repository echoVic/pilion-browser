import { expect, it } from 'vitest';
import { closeOverlay, overlayViewport, type Overlay } from '../src/renderer/overlay';

it('keeps the native page hidden, and tells main an overlay is in use, while any overlay is open', () => {
  for (const overlay of ['command', 'overview', 'browser-data'] as const)
    expect(overlayViewport(overlay, true)).toEqual({ commandBarOpen: true, visible: false });
  expect(overlayViewport('none', true)).toEqual({ commandBarOpen: false, visible: true });
  expect(overlayViewport('none', false)).toEqual({ commandBarOpen: false, visible: false });
});

it('closes only the overlay that asked to close', () => {
  const open: Overlay = 'overview';
  // 命令栏已被任务总览替换，它迟到的关闭回调不能把任务总览也关掉。
  expect(closeOverlay(open, 'command')).toBe('overview');
  expect(closeOverlay(open, 'browser-data')).toBe('overview');
  expect(closeOverlay(open, 'overview')).toBe('none');
  expect(closeOverlay('none', 'command')).toBe('none');
});
