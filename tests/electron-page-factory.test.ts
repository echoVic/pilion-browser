import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

/** Loads the way a successful loadURL does: commits, then resolves. A URL in `failing` rejects. */
class FakeContents extends EventEmitter {
  static failing = new Set<string>();
  readonly debugger = {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: () => {
      this.debugger.attached = true;
    },
    detach: () => {
      this.debugger.attached = false;
    },
  };
  private url = '';
  setWindowOpenHandler(): void {}
  stop(): void {}
  close(): void {}
  getURL(): string {
    return this.url;
  }
  async loadURL(url: string): Promise<void> {
    if (FakeContents.failing.has(url))
      throw Object.assign(new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${url}'`), {
        errno: -105,
        url,
      });
    this.url = url;
    this.emit('did-navigate', {}, url, 200);
  }
}

class FakeView {
  readonly webContents = new FakeContents();
}

vi.mock('electron', () => ({
  WebContentsView: FakeView,
  BrowserWindow: class {},
  systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) },
}));

const { ElectronPageFactory } = await import('../src/main/browser/electron-page-adapter');

function factory() {
  const window = Object.assign(new EventEmitter(), {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  });
  return {
    window,
    factory: new ElectronPageFactory(window as unknown as BrowserWindow, (url) =>
      Promise.resolve(url),
    ),
  };
}

const contentsOf = (page: unknown) => (page as { view: FakeView }).view.webContents as FakeContents;

describe('ElectronPageFactory.pages lists open pages only', () => {
  it('lets go of a page once it is closed', async () => {
    const { factory: pages } = factory();
    const first = await pages.create('https://a.test/');
    const second = await pages.create('https://b.test/');
    expect(pages.pages).toEqual([first, second]);
    first.close();
    expect(pages.pages).toEqual([second]);
    // A second close of the same page must not take another page with it.
    first.close();
    expect(pages.pages).toEqual([second]);
  });

  it('lets go of a page whose contents were destroyed without close()', async () => {
    const { factory: pages } = factory();
    const first = await pages.create('https://a.test/');
    const second = await pages.create('https://b.test/');
    contentsOf(first).emit('destroyed');
    expect(pages.pages).toEqual([second]);
    // close() after the contents went away releases nothing else.
    first.close();
    expect(pages.pages).toEqual([second]);
  });

  it('does not keep a page whose first load failed, and keeps the others', async () => {
    const { factory: pages, window } = factory();
    const open = await pages.create('https://a.test/');
    FakeContents.failing.add('https://down.test/');
    try {
      await expect(pages.create('https://down.test/')).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    } finally {
      FakeContents.failing.delete('https://down.test/');
    }
    expect(pages.pages).toEqual([open]);
    expect(window.contentView.removeChildView).toHaveBeenCalledTimes(1);
  });
});
