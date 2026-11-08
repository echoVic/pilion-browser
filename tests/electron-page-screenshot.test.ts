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

function portWith(
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): ElectronPagePort {
  const wc = Object.assign(new EventEmitter(), {
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
    capturePage: vi.fn(),
    focus: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'https://example.com/',
  });
  return new ElectronPagePort(
    { webContents: wc, setVisible: vi.fn() } as unknown as WebContentsView,
    {} as BrowserWindow,
    async (url) => url,
    { hideFor: vi.fn() } as never,
  );
}

/** 700 KiB 预算之外：造一张解码后明显超预算的大图与一张够小的小图。 */
const BIG = Buffer.alloc(900_000, 1).toString('base64');
const SMALL = Buffer.alloc(40_000, 2).toString('base64');

it('auto-downgrades an oversized capture through jpeg quality then clip.scale', async () => {
  const captures: Array<Record<string, unknown>> = [];
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.getLayoutMetrics')
      return { cssLayoutViewport: { clientWidth: 2914, clientHeight: 1952 } };
    if (method === 'Page.captureScreenshot') {
      const p = params ?? {};
      captures.push(p);
      // 只有降到 clip.scale 0.5 的 jpeg 才装得进预算。
      const fits = p.format === 'jpeg' && (p.clip as { scale?: number } | undefined)?.scale === 0.5;
      return { data: fits ? SMALL : BIG };
    }
    return {};
  });
  const result = await portWith(sendCommand).screenshot();
  expect(result.mimeType).toBe('image/jpeg');
  expect(result.downgraded).toBe(true);
  expect(result.format).toBe('jpeg');
  expect(result.quality).toBe(60);
  expect(result.scale).toBe(0.5);
  expect(Buffer.from(result.data, 'base64').length).toBeLessThanOrEqual(700 * 1024);
  // 首次按用户参数（默认 png）+ 四级降级，共 5 次。
  expect(captures).toHaveLength(5);
  expect(captures[0]).toEqual({
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  expect(captures[1]).toMatchObject({ format: 'jpeg', quality: 80 });
  expect(captures[2]).toMatchObject({ format: 'jpeg', quality: 60 });
  expect(captures[3]).toMatchObject({
    format: 'jpeg',
    quality: 60,
    clip: { x: 0, y: 0, width: 2914, height: 1952, scale: 0.75 },
  });
  expect(captures[4]).toMatchObject({
    format: 'jpeg',
    quality: 60,
    clip: { x: 0, y: 0, width: 2914, height: 1952, scale: 0.5 },
  });
});

it('stops downgrading as soon as a step fits the frame budget', async () => {
  const captures: Array<Record<string, unknown>> = [];
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Page.captureScreenshot') {
      const p = params ?? {};
      captures.push(p);
      return { data: p.format === 'jpeg' && p.quality === 80 ? SMALL : BIG };
    }
    return {};
  });
  const result = await portWith(sendCommand).screenshot();
  expect(captures).toHaveLength(2);
  expect(result.downgraded).toBe(true);
  expect(result.format).toBe('jpeg');
  expect(result.quality).toBe(80);
  expect(result.scale).toBeUndefined();
  expect(result.mimeType).toBe('image/jpeg');
});

it('passes explicit format/quality/scale/clip through and returns the jpeg mimeType', async () => {
  const data = Buffer.alloc(10_000, 3).toString('base64');
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Page.captureScreenshot' ? { data } : {},
  );
  const result = await portWith(sendCommand).screenshot({
    format: 'jpeg',
    quality: 70,
    scale: 0.8,
    clip: { x: 10, y: 20, width: 640, height: 480 },
  });
  expect(result).toEqual({ mimeType: 'image/jpeg', data });
  expect(sendCommand).toHaveBeenCalledExactlyOnceWith('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 70,
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 10, y: 20, width: 640, height: 480, scale: 0.8 },
  });
});

it('uses a full-viewport clip for an explicit --scale without a region', async () => {
  const data = Buffer.alloc(5_000, 4).toString('base64');
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.getLayoutMetrics')
      return { layoutViewport: { clientWidth: 1000, clientHeight: 700 } };
    if (method === 'Page.captureScreenshot') return { data };
    return {};
  });
  const result = await portWith(sendCommand).screenshot({ scale: 0.5 });
  expect(result).toEqual({ mimeType: 'image/png', data });
  expect(sendCommand).toHaveBeenCalledWith('Page.getLayoutMetrics', undefined);
  expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1000, height: 700, scale: 0.5 },
  });
});
