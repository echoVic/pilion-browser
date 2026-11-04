import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { expect, it, vi } from 'vitest';
import { ElectronPagePort } from '../src/main/browser/electron-page-adapter';

it('captures a fresh hidden page surface without showing or focusing its view', async () => {
  const image = Buffer.from('fresh-page-pixels').toString('base64');
  const sendCommand = vi.fn(async () => ({ data: image }));
  const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('old-pixels') }));
  const focus = vi.fn();
  const setVisible = vi.fn();
  const wc = Object.assign(new EventEmitter(), {
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
    capturePage,
    focus,
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'https://example.com/',
  });
  const port = new ElectronPagePort(
    { webContents: wc, setVisible } as unknown as WebContentsView,
    {} as BrowserWindow,
    async (url) => url,
    { hideFor: vi.fn() } as never,
  );
  expect(await port.screenshot()).toEqual({ mimeType: 'image/png', data: image });
  expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  expect(capturePage).not.toHaveBeenCalled();
  expect(setVisible).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});
