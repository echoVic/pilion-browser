import {
  app,
  BrowserWindow,
  webContents,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerInvokeEvent,
  type Session,
  type WebContents,
} from 'electron';
import { showWindow } from './window-focus.js';

const CHANNEL = 'pilion:extension-side-panel';
type RequestEvent = IpcMainInvokeEvent | IpcMainServiceWorkerInvokeEvent;
type PanelOptions = { enabled: boolean; path?: string; tabId?: number };
type Options = {
  session: Session;
  parent(): BrowserWindow;
  preload: string;
  noFocus: boolean;
  /** Must return true only for a live tab belonging to this session/window. */
  hasTab?(tabId: number): boolean;
};

/** Session-owned sidePanel compatibility. Construct before loading extensions/preload libraries. */
export class ExtensionPanels {
  private overrides = new Map<string, Map<number | undefined, PanelOptions>>();
  private behaviors = new Map<string, boolean>();
  private panel?: { id: string; tabId?: number; window: BrowserWindow };
  private frames = new Set<WebContents>();
  private workers = new Set<Electron.ServiceWorkerMain>();
  private preloadIds: string[];
  private onUnloaded = (_event: Electron.Event, extension: Electron.Extension) => {
    this.overrides.delete(extension.id);
    this.behaviors.delete(extension.id);
    if (this.panel?.id === extension.id) {
      const window = this.panel.window;
      this.panel = undefined;
      // Revoking an extension must also revoke its UI, even if beforeunload would cancel close.
      if (!window.isDestroyed()) window.destroy();
    }
  };
  private onContents = (_event: Electron.Event, contents: WebContents) => this.attach(contents);
  private onWorker = ({
    versionId,
    runningStatus,
  }: Electron.ServiceWorkersRunningStatusChangedEventParams) => {
    if (runningStatus !== 'starting' && runningStatus !== 'running') return;
    const worker = this.options.session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || this.workers.has(worker) || !worker.scope.startsWith('chrome-extension://'))
      return;
    this.workers.add(worker);
    worker.ipc.handle(CHANNEL, (event, method, details) => this.handle(event, method, details));
  };

  constructor(private options: Options) {
    this.preloadIds = ['frame', 'service-worker'].map((type) =>
      options.session.registerPreloadScript({
        type: type as 'frame' | 'service-worker',
        filePath: options.preload,
      }),
    );
    options.session.extensions.on('extension-unloaded', this.onUnloaded);
    app.on('web-contents-created', this.onContents);
    for (const contents of webContents.getAllWebContents()) this.attach(contents);
    options.session.serviceWorkers.on('running-status-changed', this.onWorker);
    for (const version of Object.keys(options.session.serviceWorkers.getAllRunning()))
      this.onWorker({ versionId: Number(version), runningStatus: 'running' });
  }

  private attach(contents: WebContents) {
    if (contents.session !== this.options.session || this.frames.has(contents)) return;
    this.frames.add(contents);
    contents.ipc.handle(CHANNEL, (event, method, details) => this.handle(event, method, details));
    contents.once('destroyed', () => this.frames.delete(contents));
  }

  private extension(id: string) {
    const extension = this.options.session.extensions.getExtension(id);
    if (!extension || !extension.manifest.permissions?.includes('sidePanel'))
      throw new Error('This extension does not have the sidePanel permission.');
    return extension;
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
        throw new Error('Untrusted sidePanel worker.');
      url = event.serviceWorker.scriptURL;
      if (new URL(url).host !== new URL(event.serviceWorker.scope).host)
        throw new Error('Invalid sidePanel worker scope.');
    } else {
      if (event.sender.session !== this.options.session || !event.senderFrame)
        throw new Error('Untrusted sidePanel frame.');
      url = event.senderFrame.url;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/.test(parsed.hostname))
      throw new Error('sidePanel is only available to extension contexts.');
    this.extension(parsed.hostname);
    return parsed.hostname;
  }

  private tab(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (this.options.hasTab && !this.options.hasTab(value as number))
    )
      throw new Error('Invalid sidePanel tabId.');
    return value as number;
  }

  private path(id: string, value: unknown): string {
    if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\'))
      throw new Error('Panel path must be a relative extension resource.');
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      throw new Error('Invalid panel path.');
    }
    if (decoded.includes('\\') || decoded.split(/[/?#]/).includes('..'))
      throw new Error('Invalid panel path.');
    const base = `chrome-extension://${id}/`;
    const url = new URL(value, base);
    if (
      url.protocol !== 'chrome-extension:' ||
      url.host !== id ||
      /^[a-z][a-z\d+.-]*:/i.test(value)
    )
      throw new Error('Panel path escapes its extension.');
    return value;
  }

  private getOptions(id: string, tabId?: number): PanelOptions {
    const extension = this.extension(id);
    const values = this.overrides.get(id);
    const manifestPath = (extension.manifest.side_panel as { default_path?: string } | undefined)
      ?.default_path;
    const defaults = values?.get(undefined) ?? {
      enabled: !!manifestPath,
      ...(manifestPath ? { path: manifestPath } : {}),
    };
    const result = (tabId === undefined ? undefined : values?.get(tabId)) ?? defaults;
    return { ...result, ...(tabId === undefined ? {} : { tabId }) };
  }

  async handle(event: RequestEvent, method: unknown, raw: unknown): Promise<unknown> {
    const id = this.caller(event);
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)))
      throw new Error('Invalid sidePanel options.');
    const details = (raw ?? {}) as Record<string, unknown>;
    const tabId = this.tab(details.tabId);
    if (details.windowId !== undefined && details.windowId !== this.options.parent().id)
      throw new Error('Invalid sidePanel windowId.');
    switch (method) {
      case 'getOptions':
        return this.getOptions(id, tabId);
      case 'setOptions': {
        if (details.enabled !== undefined && typeof details.enabled !== 'boolean')
          throw new Error('Invalid enabled value.');
        const value = this.getOptions(id, tabId);
        if (details.path !== undefined) value.path = this.path(id, details.path);
        if (details.enabled !== undefined) value.enabled = details.enabled as boolean;
        let values = this.overrides.get(id);
        if (!values) this.overrides.set(id, (values = new Map()));
        values.set(tabId, value);
        if (this.panel?.id === id && (tabId === undefined || this.panel.tabId === tabId)) {
          if (!value.enabled) this.close(id);
          else if (details.path !== undefined) await this.open(id, this.panel.tabId);
        }
        return;
      }
      case 'setPanelBehavior':
        if (typeof details.openPanelOnActionClick !== 'boolean')
          throw new Error('Invalid panel behavior.');
        this.behaviors.set(id, details.openPanelOnActionClick);
        return;
      case 'getPanelBehavior':
        return { openPanelOnActionClick: this.behaviors.get(id) ?? false };
      case 'open':
        await this.open(id, tabId);
        return;
      case 'close':
        if (this.panel?.id === id && (tabId === undefined || this.panel.tabId === tabId))
          this.close(id);
        return;
      default:
        throw new Error(`Unsupported sidePanel method: ${String(method)}`);
    }
  }

  isEnabled(id: string, tabId?: number): boolean {
    const options = this.getOptions(id, this.tab(tabId));
    return options.enabled && !!options.path;
  }

  opensOnActionClick(id: string, tabId?: number): boolean {
    if (!this.behaviors.get(id)) return false;
    const config = this.getOptions(id, this.tab(tabId));
    return config.enabled && !!config.path;
  }

  async open(id: string, tabId?: number): Promise<void> {
    tabId = this.tab(tabId);
    const config = this.getOptions(id, tabId);
    if (!config.enabled || !config.path) throw new Error('No enabled side panel is configured.');
    const path = this.path(id, config.path);
    if (
      this.panel?.id === id &&
      this.panel.tabId === tabId &&
      this.panel.window.webContents.getURL() === `chrome-extension://${id}/${path}`
    ) {
      this.show(this.panel.window);
      return;
    }
    this.close();
    const parent = this.options.parent();
    const bounds = () => {
      const area = parent.getContentBounds();
      const width = Math.min(440, area.width);
      return {
        x: area.x + area.width - width,
        y: area.y + 76,
        width,
        height: Math.max(100, area.height - 76),
      };
    };
    const window = new BrowserWindow({
      ...bounds(),
      parent,
      title: this.extension(id).name ?? 'Extension side panel',
      show: false,
      frame: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        session: this.options.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    this.panel = { id, tabId, window };
    const reposition = () => {
      if (!window.isDestroyed() && !parent.isDestroyed()) window.setBounds(bounds());
    };
    parent.on('move', reposition);
    parent.on('resize', reposition);
    window.once('closed', () => {
      parent.removeListener('move', reposition);
      parent.removeListener('resize', reposition);
      if (this.panel?.window === window) this.panel = undefined;
    });
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'Escape') window.close();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const confine = (event: { url: string; preventDefault(): void }) => {
      const target = URL.parse(event.url);
      if (target?.protocol !== 'chrome-extension:' || target.host !== id) event.preventDefault();
    };
    window.webContents.on('will-navigate', confine);
    window.webContents.on('will-redirect', confine);
    try {
      await window.loadURL(`chrome-extension://${id}/${path}`);
      if (!window.isDestroyed() && this.panel?.window === window) this.show(window);
    } catch (error) {
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  }

  private show(window: BrowserWindow) {
    if (this.options.noFocus) window.showInactive();
    else showWindow(window);
  }

  close(id?: string) {
    if (this.panel && (id === undefined || this.panel.id === id)) this.panel.window.close();
  }

  dispose() {
    this.close();
    this.options.session.extensions.removeListener('extension-unloaded', this.onUnloaded);
    app.removeListener('web-contents-created', this.onContents);
    this.options.session.serviceWorkers.removeListener('running-status-changed', this.onWorker);
    for (const contents of this.frames)
      if (!contents.isDestroyed()) contents.ipc.removeHandler(CHANNEL);
    for (const worker of this.workers) if (!worker.isDestroyed()) worker.ipc.removeHandler(CHANNEL);
    for (const id of this.preloadIds) this.options.session.unregisterPreloadScript(id);
  }
}
