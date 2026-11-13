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
  { zoom = 1, bounds }: { zoom?: number; bounds?: { width: number; height: number } } = {},
): ElectronPagePort {
  const wc = Object.assign(new EventEmitter(), {
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
    capturePage: vi.fn(),
    focus: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'https://example.com/',
    getZoomFactor: () => zoom,
  });
  return new ElectronPagePort(
    {
      webContents: wc,
      setVisible: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 0, height: 0, ...bounds }),
    } as unknown as WebContentsView,
    {} as BrowserWindow,
    async (url) => url,
    { hideFor: vi.fn() } as never,
  );
}

function captureCalls(sendCommand: { mock: { calls: unknown[][] } }): unknown[] {
  return sendCommand.mock.calls
    .filter(([method]) => method === 'Page.captureScreenshot')
    .map(([, params]) => params);
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
  expect(captureCalls(sendCommand)).toEqual([
    {
      format: 'jpeg',
      quality: 70,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 10, y: 20, width: 640, height: 480, scale: 0.8 },
    },
  ]);
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

/** 一张只有 PNG 头的图：尺寸读得出来，像素是假的。 */
function png(width: number, height: number): string {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(2_000, 9)]).toString('base64');
}

it('scales a CSS-pixel clip by the zoom factor and reports image and CSS geometry (issue #7)', async () => {
  const data = png(1200, 800);
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Page.captureScreenshot' ? { data } : {},
  );
  const result = await portWith(sendCommand, { zoom: 2 }).screenshot({
    clip: { x: 8, y: 40.5, width: 300, height: 200 },
  });
  expect(captureCalls(sendCommand)).toEqual([
    {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
      // scale 在 CDP 的 clip 里是必填：只给区域不给 --scale 时也要带上 1，否则 Chromium 以 Invalid parameters 拒绝。
      clip: { x: 16, y: 81, width: 600, height: 400, scale: 1 },
    },
  ]);
  expect(result).toEqual({
    mimeType: 'image/png',
    data,
    width: 1200,
    height: 800,
    cssWidth: 300,
    cssHeight: 200,
  });
});

it('starts a scaled full-viewport clip at the scroll position (issue #7)', async () => {
  const data = png(625, 438);
  const sendCommand = vi.fn(async (method: string) => {
    if (method === 'Page.getLayoutMetrics')
      return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 1500 } };
    if (method === 'Page.captureScreenshot') return { data };
    return {};
  });
  const result = await portWith(sendCommand, { zoom: 1.25 }).screenshot({ scale: 0.5 });
  expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 1875, width: 1250, height: 875, scale: 0.5 },
  });
  expect(result).toMatchObject({ width: 625, height: 438, cssWidth: 1000, cssHeight: 700 });
});

it('reports the CSS size of a full capture from the view bounds and zoom (issue #7)', async () => {
  const data = png(2560, 1600);
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Page.captureScreenshot' ? { data } : {},
  );
  const result = await portWith(sendCommand, {
    zoom: 1.25,
    bounds: { width: 1280, height: 800 },
  }).screenshot();
  expect(result).toEqual({
    mimeType: 'image/png',
    data,
    width: 2560,
    height: 1600,
    cssWidth: 1024,
    cssHeight: 640,
  });
  // 读不出视图尺寸时只是不报几何，旧字段不变。
  const unknown = await portWith(sendCommand).screenshot();
  expect(unknown).toEqual({ mimeType: 'image/png', data });
});

// 视口 1000×700，滚到 y=1400：页面上可见的是 y 1400–2100。
function scrolledTo1400(data: string) {
  return vi.fn(async (method: string) => {
    if (method === 'Page.getLayoutMetrics')
      return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 1400 } };
    return method === 'Page.captureScreenshot' ? { data } : {};
  });
}

it.each([
  [
    'below',
    { x: 40, y: 2100, width: 300, height: 200 },
    /y 2100 to 2300.*y 1400 to 2100.*scroll down 700,/,
  ],
  [
    'above',
    { x: 40, y: 100, width: 300, height: 200 },
    /y 100 to 300.*y 1400 to 2100.*scroll up 1300,/,
  ],
  ['to the side', { x: 1000, y: 1500, width: 300, height: 200 }, /x 1000 to 1300.*x 0 to 1000/],
] as const)(
  'refuses a clip that is wholly %s the visible page instead of returning a blank image',
  async (_where, clip, message) => {
    const sendCommand = scrolledTo1400(png(600, 400));
    await expect(portWith(sendCommand).screenshot({ clip })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      outcome: 'not_applied',
      message: expect.stringMatching(message),
    });
    expect(captureCalls(sendCommand)).toEqual([]);
  },
);

it('marks a clip that is only partly in the visible page, and not one that fits', async () => {
  const data = png(600, 400);
  const partly = await portWith(scrolledTo1400(data)).screenshot({
    clip: { x: 40, y: 2000, width: 300, height: 200 },
  });
  expect(partly).toEqual({
    mimeType: 'image/png',
    data,
    width: 600,
    height: 400,
    cssWidth: 300,
    cssHeight: 200,
    partial: true,
  });
  // 盒子带小数、视口是整数：半个像素以内不算越界。
  const fits = await portWith(scrolledTo1400(data)).screenshot({
    clip: { x: 40, y: 1900.4, width: 300, height: 200 },
  });
  expect(fits).not.toHaveProperty('partial');
});
