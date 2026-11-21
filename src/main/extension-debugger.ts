import {
  app,
  webContents,
  type Session,
  type WebContents,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerInvokeEvent,
} from 'electron';

const CHANNEL = 'pilion:extension-debugger';
const EVENTS = `${CHANNEL}-event`;
type RequestEvent = IpcMainInvokeEvent | IpcMainServiceWorkerInvokeEvent;
type Options = {
  session: Session;
  preload: string;
  tabs(): WebContents[];
  validateUrl(url: string): Promise<string>;
  noFocus?: boolean;
};
type Lease = {
  owner: string;
  page: WebContents;
  children: Set<string>;
  sessionId?: string;
  ready: Promise<void>;
  closed: boolean;
  cleanup?: Promise<void>;
  message: (
    event: Electron.Event,
    command: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ) => void;
  detached: (event: Electron.Event, reason: string) => void;
  destroyed: () => void;
};
// Explicit page-scoped surface. In particular no file upload, cookies, interception,
// browser context, security override, download path, or process-global commands.
const COMMANDS = new Set(
  `Runtime.enable Runtime.disable Runtime.evaluate Runtime.callFunctionOn Runtime.getProperties Runtime.releaseObject Runtime.releaseObjectGroup Runtime.awaitPromise Runtime.runIfWaitingForDebugger Runtime.getHeapUsage Runtime.addBinding Runtime.removeBinding
DOM.enable DOM.disable DOM.getDocument DOM.getFlattenedDocument DOM.querySelector DOM.querySelectorAll DOM.describeNode DOM.resolveNode DOM.requestNode DOM.getBoxModel DOM.getContentQuads DOM.getNodeForLocation DOM.getOuterHTML DOM.setOuterHTML DOM.setAttributeValue DOM.removeAttribute DOM.focus DOM.scrollIntoViewIfNeeded DOM.requestChildNodes DOM.performSearch DOM.getSearchResults DOM.discardSearchResults
Page.enable Page.disable Page.getFrameTree Page.getLayoutMetrics Page.captureScreenshot Page.navigate Page.reload Page.stopLoading Page.bringToFront Page.addScriptToEvaluateOnNewDocument Page.removeScriptToEvaluateOnNewDocument Page.createIsolatedWorld Page.getNavigationHistory Page.navigateToHistoryEntry Page.handleJavaScriptDialog
Input.dispatchMouseEvent Input.dispatchKeyEvent Input.insertText Input.dispatchTouchEvent Input.synthesizeScrollGesture Input.synthesizeTapGesture
Accessibility.enable Accessibility.disable Accessibility.getFullAXTree Accessibility.getPartialAXTree Accessibility.getRootAXNode Accessibility.getChildAXNodes Accessibility.queryAXTree
Network.enable Network.disable Network.getResponseBody Network.getRequestPostData
DOMSnapshot.captureSnapshot CSS.enable CSS.disable CSS.getComputedStyleForNode CSS.getMatchedStylesForNode CSS.getInlineStylesForNode CSS.getStyleSheetText`.split(
    /\s+/,
  ),
);

/** Virtual extension ownership over Pilion's existing page debugger transport. */
export class ExtensionDebugger {
  private leases = new Map<number, Lease>();
  private disposed = false;
  private disposal?: Promise<void>;
  private onUnloaded = (_event: Electron.Event, extension: Electron.Extension) => {
    for (const lease of this.leases.values())
      if (lease.owner === extension.id) void this.release(lease, 'canceled_by_user');
    this.subscribers.delete(extension.id);
  };
  private subscribers = new Map<string, Map<object, (...args: unknown[]) => void>>();
  private frames = new Set<WebContents>();
  private workers = new Set<Electron.ServiceWorkerMain>();
  private preloadIds: string[];
  private onContents = (_event: Electron.Event, contents: WebContents) => this.install(contents);
  private onWorker = ({
    versionId,
    runningStatus,
  }: Electron.ServiceWorkersRunningStatusChangedEventParams) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return;
    const worker = this.options.session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || this.workers.has(worker) || !worker.scope.startsWith('chrome-extension://'))
      return;
    this.workers.add(worker);
    worker.ipc.handle(CHANNEL, (event, method, args) => this.handle(event, method, args));
  };
  constructor(private options: Options) {
    this.preloadIds = (['frame', 'service-worker'] as const).map((type) =>
      options.session.registerPreloadScript({ type, filePath: options.preload }),
    );
    app.on('web-contents-created', this.onContents);
    options.session.extensions.on('extension-unloaded', this.onUnloaded);
    for (const contents of webContents.getAllWebContents()) this.install(contents);
    options.session.serviceWorkers.on('running-status-changed', this.onWorker);
    for (const version of Object.keys(options.session.serviceWorkers.getAllRunning()))
      this.onWorker({ versionId: Number(version), runningStatus: 'running' });
  }
  private install(contents: WebContents) {
    if (contents.session !== this.options.session || this.frames.has(contents)) return;
    this.frames.add(contents);
    contents.ipc.handle(CHANNEL, (event, method, args) => this.handle(event, method, args));
    contents.once('destroyed', () => this.frames.delete(contents));
  }
  private caller(event: RequestEvent): string {
    let url: string;
    if (event.type === 'service-worker') {
      if (
        event.session !== this.options.session ||
        event.serviceWorker.isDestroyed() ||
        this.options.session.serviceWorkers.getWorkerFromVersionID(event.versionId) !==
          event.serviceWorker
      )
        throw Error('Untrusted debugger worker.');
      url = event.serviceWorker.scriptURL;
      const scope = new URL(event.serviceWorker.scope);
      if (scope.protocol !== 'chrome-extension:' || scope.host !== new URL(url).host)
        throw Error('Invalid debugger worker scope.');
    } else {
      if (event.sender.session !== this.options.session || !event.senderFrame)
        throw Error('Untrusted debugger frame.');
      url = event.senderFrame.url;
    }
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'chrome-extension:' ||
      !/^[a-p]{32}$/.test(parsed.hostname) ||
      !this.options.session.extensions
        .getExtension(parsed.hostname)
        ?.manifest.permissions?.includes('debugger')
    )
      throw Error('Extension debugger permission required.');
    return parsed.hostname;
  }
  private page(tabId: unknown): WebContents {
    const page = this.options
      .tabs()
      .find(
        (page) => page.id === tabId && !page.isDestroyed() && page.session === this.options.session,
      );
    if (!Number.isInteger(tabId) || !page || !/^(https?:|about:blank$)/.test(page.getURL()))
      throw Error('Debugger target is not a live browser page.');
    return page;
  }
  private emit(owner: string, ...args: unknown[]) {
    for (const [key, send] of this.subscribers.get(owner) ?? []) {
      try {
        send(...args);
      } catch {
        this.subscribers.get(owner)?.delete(key);
      }
    }
  }
  private release(lease: Lease, reason?: string): Promise<void> {
    if (lease.cleanup) return lease.cleanup;
    lease.closed = true;
    lease.page.debugger.removeListener('message', lease.message);
    lease.page.debugger.removeListener('detach', lease.detached);
    lease.page.removeListener('destroyed', lease.destroyed);
    if (reason) this.emit(lease.owner, 'onDetach', { tabId: lease.page.id }, reason);
    lease.cleanup = (async () => {
      // An unload can arrive while Target.attachToTarget is still in flight.
      // Retain the reservation until that owned session is known and detached.
      await lease.ready.catch(() => undefined);
      if (lease.sessionId && !lease.page.isDestroyed() && lease.page.debugger.isAttached()) {
        await lease.page.debugger.sendCommand('Target.detachFromTarget', {
          sessionId: lease.sessionId,
        });
      }
      if (this.leases.get(lease.page.id) === lease) this.leases.delete(lease.page.id);
    })();
    // Teardown triggered by Electron events has no awaiting caller. Keep failures
    // handled but retain the closed reservation if cleanup cannot be confirmed.
    void lease.cleanup.catch((error) => console.error('Extension debugger cleanup failed', error));
    return lease.cleanup;
  }
  async handle(event: RequestEvent, method: unknown, raw: unknown): Promise<unknown> {
    if (this.disposed) throw Error('Extension debugger has been disposed.');
    const owner = this.caller(event);
    if (!Array.isArray(raw)) throw Error('Invalid debugger arguments.');
    if (method === 'subscribe') {
      let subscriptions = this.subscribers.get(owner);
      if (!subscriptions) this.subscribers.set(owner, (subscriptions = new Map()));
      const endpoint = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
      subscriptions.set(endpoint, (...args) => {
        // Recheck origin, permission and lifetime at event delivery as well.
        if (this.caller(event) !== owner) throw Error('Expired debugger context.');
        endpoint.send(EVENTS, ...args);
      });
      return;
    }
    if (method === 'getTargets')
      return this.options
        .tabs()
        .filter((page) => {
          try {
            return this.page(page.id) === page;
          } catch {
            return false;
          }
        })
        .map((page) => ({
          id: String(page.id),
          tabId: page.id,
          type: 'page',
          title: page.getTitle(),
          url: page.getURL(),
          attached: this.leases.has(page.id),
        }));
    const source = raw[0];
    if (
      !source ||
      typeof source !== 'object' ||
      Array.isArray(source) ||
      Object.keys(source).some((key) => !['tabId', 'sessionId'].includes(key))
    )
      throw Error('Only page tabId debugger targets are supported.');
    const page = this.page(source.tabId);
    if (
      source.sessionId !== undefined &&
      (typeof source.sessionId !== 'string' || !source.sessionId)
    )
      throw Error('Invalid debugger session.');
    if (method === 'attach') {
      if (source.sessionId !== undefined || !['1.0', '1.1', '1.2', '1.3'].includes(raw[1]))
        throw Error('Unsupported debugger protocol.');
      const previous = this.leases.get(page.id);
      if (previous?.closed) await previous.cleanup;
      if (this.leases.has(page.id)) throw Error('Another debugger is already attached.');
      if (this.disposed || this.caller(event) !== owner || this.page(page.id) !== page)
        throw Error('Debugger target changed.');
      if (!page.debugger.isAttached()) throw Error('Page debugger transport is unavailable.');
      const lease: Lease = {
        owner,
        page,
        children: new Set(),
        ready: Promise.resolve(),
        closed: false,
        message: () => {},
        detached: () => {},
        destroyed: () => {},
      };
      lease.message = (
        _event,
        command: string,
        params: Record<string, unknown>,
        sessionId?: string,
      ) => {
        if (!lease.sessionId || lease.closed) return;
        try {
          if (this.page(page.id) !== page) {
            this.release(lease, 'target_closed');
            return;
          }
        } catch {
          this.release(lease, 'target_closed');
          return;
        }
        if (command === 'Target.detachedFromTarget' && params.sessionId === lease.sessionId) {
          lease.sessionId = undefined;
          void this.release(lease, 'target_closed');
          return;
        }
        if (sessionId !== lease.sessionId && (!sessionId || !lease.children.has(sessionId))) return;
        if (command === 'Target.attachedToTarget') {
          const targetInfo = params.targetInfo as { type?: string; url?: string } | undefined;
          if (
            targetInfo?.type !== 'iframe' ||
            !/^(https?:|about:blank$|$)/.test(targetInfo?.url ?? '') ||
            typeof params.sessionId !== 'string'
          )
            return;
          lease.children.add(params.sessionId);
        }
        if (command === 'Target.detachedFromTarget') {
          if (typeof params.sessionId !== 'string' || !lease.children.delete(params.sessionId))
            return;
        }
        if (
          command.startsWith('Target.') &&
          !['Target.attachedToTarget', 'Target.detachedFromTarget'].includes(command)
        )
          return;
        this.emit(
          owner,
          'onEvent',
          { tabId: page.id, ...(sessionId && sessionId !== lease.sessionId ? { sessionId } : {}) },
          command,
          params,
        );
      };
      lease.detached = (_event, reason) =>
        void this.release(lease, reason === 'target_closed' ? 'target_closed' : 'canceled_by_user');
      lease.destroyed = () => {
        void this.release(lease, 'target_closed');
      };
      this.leases.set(page.id, lease);
      page.debugger.on('message', lease.message);
      page.debugger.on('detach', lease.detached);
      page.once('destroyed', lease.destroyed);
      lease.ready = (async () => {
        const { targetInfo } = await page.debugger.sendCommand('Target.getTargetInfo');
        if (lease.closed) return;
        if (
          this.page(page.id) !== page ||
          targetInfo?.type !== 'page' ||
          typeof targetInfo.targetId !== 'string'
        )
          throw Error('Invalid page debugger target.');
        const { sessionId } = await page.debugger.sendCommand('Target.attachToTarget', {
          targetId: targetInfo.targetId,
          flatten: true,
        });
        if (typeof sessionId !== 'string' || !sessionId)
          throw Error('Isolated page debugger session unavailable.');
        lease.sessionId = sessionId;
      })();
      try {
        await lease.ready;
        if (lease.closed) throw Error('Debugger attachment ended.');
      } catch (error) {
        await this.release(lease);
        throw error;
      }
      return;
    }
    const lease = this.leases.get(page.id);
    if (
      !lease ||
      lease.closed ||
      !lease.sessionId ||
      lease.owner !== owner ||
      (source.sessionId !== undefined && !lease.children.has(source.sessionId))
    )
      throw Error('Debugger is not attached to this target/session.');
    if (method === 'detach') {
      if (source.sessionId !== undefined) throw Error('Detach the page debugger.');
      await this.release(lease);
      return;
    }
    if (method !== 'sendCommand' || typeof raw[1] !== 'string')
      throw Error('Unsupported debugger method.');
    const command = raw[1];
    let params = raw[2] ?? {};
    if (typeof params !== 'object' || Array.isArray(params))
      throw Error('Invalid command parameters.');
    if (command === 'Target.setAutoAttach') {
      if (
        typeof params.autoAttach !== 'boolean' ||
        params.flatten !== true ||
        params.waitForDebuggerOnStart === true
      )
        throw Error('Only flattened iframe auto attach is supported.');
      params = {
        autoAttach: params.autoAttach,
        flatten: true,
        waitForDebuggerOnStart: false,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      };
    } else if (!COMMANDS.has(command)) throw Error(`Debugger command is not allowed: ${command}`);
    if (command === 'Page.bringToFront' && this.options.noFocus)
      throw Error('Focusing pages is disabled.');
    if (
      command === 'Page.createIsolatedWorld' &&
      (params.grantUniveralAccess || params.grantUniversalAccess)
    )
      throw Error('Universal world access is not allowed.');
    if (command === 'Page.navigate') {
      if (typeof params.url !== 'string') throw Error('Navigation URL required.');
      params = { ...params, url: await this.options.validateUrl(params.url) };
    }
    if (
      this.disposed ||
      lease.closed ||
      this.leases.get(page.id) !== lease ||
      this.page(page.id) !== page ||
      this.caller(event) !== owner
    )
      throw Error('Debugger target changed.');
    // The root source maps to our isolated page session, never Pilion's native
    // session. Child IDs are accepted only after observing this session's events.
    const result = await page.debugger.sendCommand(
      command,
      params,
      source.sessionId ?? lease.sessionId,
    );
    if (lease.closed) throw Error('Debugger attachment ended.');
    return result;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const cleanups = [...this.leases.values()].map((lease) => this.release(lease));
    this.options.session.extensions.removeListener('extension-unloaded', this.onUnloaded);
    app.removeListener('web-contents-created', this.onContents);
    this.options.session.serviceWorkers.removeListener('running-status-changed', this.onWorker);
    for (const frame of this.frames) if (!frame.isDestroyed()) frame.ipc.removeHandler(CHANNEL);
    for (const worker of this.workers) if (!worker.isDestroyed()) worker.ipc.removeHandler(CHANNEL);
    for (const id of this.preloadIds) this.options.session.unregisterPreloadScript(id);
    this.subscribers.clear();
    this.disposal = Promise.all(cleanups).then(() => undefined);
    return this.disposal;
  }
}
