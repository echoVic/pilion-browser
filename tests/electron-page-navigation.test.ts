import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { AgentPointer } from '../src/main/browser/agent-pointer';
import { BrowserError } from '../src/main/browser/errors';
import { ElectronPagePort } from '../src/main/browser/electron-page-adapter';

type Reply =
  | 'ok'
  | 'committed'
  | 'pending'
  | { redirect: string }
  | { fail: { code: number; description: string } };
type LoadError = { errorCode: number; errorDescription: string; url: string };

class FakeEvent {
  defaultPrevented = false;
  readonly isSameDocument = false;
  constructor(
    readonly url: string,
    readonly isMainFrame = true,
  ) {}
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

/**
 * Serves canned replies and settles loadURL the way Electron 43 does (lib/browser/api/web-contents.ts,
 * _awaitNextLoad): a load that stops without did-finish-load or did-fail-load rejects with
 * ERR_FAILED (-2) naming the URL passed to loadURL. A redirect cancelled in will-redirect ends
 * exactly like that, because Chromium reports the cancel as ERR_ABORTED, which has no did-fail-load.
 * The tab only reports did-stop-loading when nothing else is loading: while the page being replaced
 * is still fetching something, the cancelled load never reports back at all. Such a page is also
 * aborted when the new navigation starts, and Electron reports that as a main-frame did-fail-load
 * (-3, no description, the old page's URL) that the new loadURL then records as its own error.
 */
class FakeWebContents extends EventEmitter {
  readonly loads: string[] = [];
  readonly debugger = { isAttached: () => true, attach: () => undefined };
  abortsReplacedPage = false;
  private committed = '';

  constructor(
    private readonly site: Record<string, Reply>,
    private readonly replacedPageStillLoading = false,
  ) {
    super();
  }

  setWindowOpenHandler(): void {}
  stop(): void {}

  getURL(): string {
    return this.committed;
  }

  loadURL(url: string): Promise<void> {
    if (this.loads.length >= 100) throw new Error('runaway redirect loop');
    this.loads.push(url);
    const settled = this.awaitNextLoad(url);
    settled.catch(() => undefined);
    setImmediate(() => this.serve(url));
    return settled;
  }

  private awaitNextLoad(navigationUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let loadError: LoadError | undefined;
      let navigationStarted = false;
      const removeListeners = () => {
        this.off('did-finish-load', finishListener);
        this.off('did-fail-load', failListener);
        this.off('did-start-navigation', navigationListener);
        this.off('did-stop-loading', stopLoadingListener);
      };
      const rejectAndCleanup = ({ errorCode, errorDescription, url }: LoadError) => {
        removeListeners();
        reject(
          Object.assign(new Error(`${errorDescription} (${errorCode}) loading '${url}'`), {
            errno: errorCode,
            code: errorDescription,
            url,
          }),
        );
      };
      const finishListener = () => {
        if (loadError) rejectAndCleanup(loadError);
        else {
          removeListeners();
          resolve();
        }
      };
      const navigationListener = (
        _event: unknown,
        url: string,
        isSameDocument: boolean,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return;
        if (navigationStarted && !isSameDocument)
          return rejectAndCleanup({ errorCode: -3, errorDescription: 'ERR_ABORTED', url });
        navigationStarted = true;
      };
      const failListener = (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        url: string,
        isMainFrame: boolean,
      ) => {
        if (!loadError && isMainFrame) loadError = { errorCode, errorDescription, url };
        if (!navigationStarted && isMainFrame) finishListener();
      };
      const stopLoadingListener = () => {
        loadError ??= { errorCode: -2, errorDescription: 'ERR_FAILED', url: navigationUrl };
        finishListener();
      };
      this.on('did-finish-load', finishListener);
      this.on('did-fail-load', failListener);
      this.on('did-start-navigation', navigationListener);
      this.on('did-stop-loading', stopLoadingListener);
    });
  }

  private serve(start: string): void {
    this.emit('did-start-loading');
    this.emit('did-start-navigation', new FakeEvent(start), start, false, true);
    if (this.abortsReplacedPage) this.emit('did-fail-load', {}, -3, '', this.committed, true);
    let url = start;
    for (;;) {
      const reply = this.site[url] ?? { fail: { code: -6, description: 'ERR_FILE_NOT_FOUND' } };
      if (reply === 'pending') return;
      if (reply === 'committed') {
        this.committed = url;
        this.emit('did-navigate', {}, url, 200);
        return;
      }
      if (reply === 'ok') {
        this.committed = url;
        this.emit('did-navigate', {}, url, 200);
        this.emit('did-finish-load');
        this.emit('did-stop-loading');
        return;
      }
      if ('fail' in reply) {
        this.committed = url;
        this.emit('did-fail-load', {}, reply.fail.code, reply.fail.description, url, true);
        this.emit('did-stop-loading');
        return;
      }
      const redirect = new FakeEvent(reply.redirect);
      this.emit('will-redirect', redirect, reply.redirect, false, true);
      if (redirect.defaultPrevented) {
        if (!this.replacedPageStillLoading) this.emit('did-stop-loading');
        return;
      }
      url = reply.redirect;
    }
  }
}

function setup(
  site: Record<string, Reply>,
  validate: (url: string) => Promise<string> = (url) => Promise.resolve(url),
  options: { replacedPageStillLoading?: boolean } = {},
) {
  const contents = new FakeWebContents(site, options.replacedPageStillLoading);
  const policy = vi.fn(validate);
  const port = new ElectronPagePort(
    { webContents: contents } as unknown as WebContentsView,
    {} as BrowserWindow,
    policy,
    {} as AgentPointer,
  );
  return { port, contents, policy };
}

const START = 'https://a.test/start';
const LANDING = 'https://a.test/landing';

describe('ElectronPagePort.navigate and server redirects', () => {
  it('follows a redirect inside the navigation instead of failing it', async () => {
    const { port, contents } = setup({ [START]: { redirect: LANDING }, [LANDING]: 'ok' });
    await port.navigate(START);
    expect(contents.loads).toEqual([START, LANDING]);
  });

  it('follows a redirect while the page it replaces is still loading', async () => {
    const { port, contents } = setup(
      { [START]: { redirect: LANDING }, [LANDING]: 'ok' },
      undefined,
      {
        replacedPageStillLoading: true,
      },
    );
    await port.navigate(START);
    expect(contents.loads).toEqual([START, LANDING]);
  });

  it('loads the policy-approved form of every hop, in order', async () => {
    const { port, contents, policy } = setup(
      {
        [START]: { redirect: 'http://a.test/hop' },
        'https://a.test/hop': { redirect: LANDING },
        [LANDING]: 'ok',
      },
      (url) => Promise.resolve(url.replace('http://', 'https://')),
    );
    await port.navigate(START);
    expect(policy.mock.calls.map(([url]) => url)).toEqual([START, 'http://a.test/hop', LANDING]);
    expect(contents.loads).toEqual([START, 'https://a.test/hop', LANDING]);
  });

  it('fails with the policy error, and loads nothing, when a redirect target is not allowed', async () => {
    const internal = 'https://internal.test/admin';
    const { port, contents } = setup(
      { [START]: { redirect: internal }, [internal]: 'ok' },
      async (url) => {
        if (url === internal)
          throw new BrowserError(
            'PRIVATE_NETWORK_BLOCKED',
            'Hostname resolves to a private network',
          );
        return url;
      },
    );
    await expect(port.navigate(START)).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED' });
    expect(contents.loads).toEqual([START]);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const a = 'https://loop.test/a';
    const b = 'https://loop.test/b';
    const { port, contents } = setup({ [a]: { redirect: b }, [b]: { redirect: a } });
    await expect(port.navigate(a)).rejects.toThrow(`ERR_TOO_MANY_REDIRECTS (-310) loading '${a}'`);
    expect(contents.loads.length).toBeLessThanOrEqual(21);
  });

  it('still reports a load that really failed', async () => {
    const { port } = setup({
      [START]: { fail: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } },
    });
    await expect(port.navigate(START)).rejects.toThrow(
      `ERR_NAME_NOT_RESOLVED (-105) loading '${START}'`,
    );
  });

  it('stops following a redirect chain once the operation is aborted', async () => {
    const controller = new AbortController();
    const { port, contents } = setup({ [START]: { redirect: LANDING }, [LANDING]: 'ok' }, (url) => {
      if (url === LANDING) controller.abort(new Error('revoked'));
      return Promise.resolve(url);
    });
    await expect(port.navigate(START, controller.signal)).rejects.toThrow('revoked');
    expect(contents.loads).toEqual([START]);
  });

  it('still replays a navigation the page started itself through the URL policy', async () => {
    const clicked = 'https://a.test/clicked';
    const { port, contents, policy } = setup({
      [START]: 'ok',
      [clicked]: { redirect: LANDING },
      [LANDING]: 'ok',
    });
    await port.navigate(START);
    const click = new FakeEvent(clicked);
    contents.emit('will-navigate', click, clicked, false, true);
    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(contents.loads).toEqual([START, clicked, LANDING]));
    expect(policy).toHaveBeenCalledWith(clicked);
  });

  it('does not turn a subframe redirect into a navigation of the page itself', async () => {
    const pixel = 'https://ads.test/pixel';
    const { port, contents } = setup({ [START]: 'ok' });
    await port.navigate(START);
    const frameRedirect = new FakeEvent(pixel, false);
    contents.emit('will-redirect', frameRedirect, pixel, false, false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(frameRedirect.defaultPrevented).toBe(false);
    expect(contents.loads).toEqual([START]);
  });
});

describe('ElectronPagePort.navigate away from a page that is still loading', () => {
  const PREVIOUS = 'https://a.test/previous';

  it('does not fail a load that finished because the page it replaced was aborted', async () => {
    const { port, contents } = setup({ [PREVIOUS]: 'ok', [START]: 'ok' });
    await port.navigate(PREVIOUS);
    contents.abortsReplacedPage = true;
    await port.navigate(START);
    expect(contents.loads).toEqual([PREVIOUS, START]);
  });

  it('still fails a load that a newer navigation superseded after it committed', async () => {
    const newer = 'https://a.test/newer';
    const { port, contents } = setup({ [START]: 'committed', [newer]: 'pending' });
    const superseded = expect(port.navigate(START)).rejects.toThrow(
      `ERR_ABORTED (-3) loading '${newer}'`,
    );
    await vi.waitFor(() => expect(contents.getURL()).toBe(START));
    void contents.loadURL(newer);
    await superseded;
  });

  it('still fails a load that was stopped before it committed', async () => {
    const { port, contents } = setup({ [PREVIOUS]: 'ok', [START]: 'pending' });
    await port.navigate(PREVIOUS);
    contents.abortsReplacedPage = true;
    const stopped = expect(port.navigate(START)).rejects.toThrow();
    await vi.waitFor(() => expect(contents.loads).toEqual([PREVIOUS, START]));
    await new Promise((resolve) => setImmediate(resolve));
    contents.emit('did-stop-loading');
    await stopped;
  });

  it('still fails a load that really failed, even when the aborted page is reported first', async () => {
    const { port, contents } = setup({
      [PREVIOUS]: 'ok',
      [START]: { fail: { code: -102, description: 'ERR_CONNECTION_REFUSED' } },
    });
    await port.navigate(PREVIOUS);
    contents.abortsReplacedPage = true;
    await expect(port.navigate(START)).rejects.toThrow();
  });
});
