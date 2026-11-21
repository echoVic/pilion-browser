import {
  app,
  Menu,
  type ContextMenuParams,
  type Input,
  webContents,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebFrameMain,
  type ServiceWorkerMain,
  type IpcMainInvokeEvent,
  type IpcMainServiceWorkerInvokeEvent,
} from 'electron';
import { ExtensionContextMenus } from './extension-context-menus.js';

const CHANNEL = 'pilion:extension-tab-groups';
const EVENTS = `${CHANNEL}:event`;
type BrowserEvent =
  | 'downloads.onCreated'
  | 'downloads.onChanged'
  | 'webNavigation.onCreatedNavigationTarget'
  | 'webNavigation.onCompleted'
  | 'tabs.onUpdated';
type RequestEvent = IpcMainInvokeEvent | IpcMainServiceWorkerInvokeEvent;
type Group = {
  id: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
  shared: boolean;
};
type Options = {
  session: Session;
  parent(): BrowserWindow;
  tabs(): WebContents[];
  preload: string;
  openAction?(id: string): Promise<void>;
  openWebTab?(url: string, active: boolean): Promise<{ id: number; windowId: number }>;
  closeWebTab?(id: number): Promise<void>;
  onChange?(): void;
  /** Reorder existing native tabs; this must not change Agent Space/task ownership. */
  moveTabs?(tabIds: number[], index: number): void | Promise<void>;
};
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** Session-lifetime Chrome group metadata. No native group UI or restart persistence. */
export class ExtensionTabGroups {
  private readonly contextMenus = new ExtensionContextMenus();
  private readonly menuSubscribers = new Map<
    WebFrameMain | ServiceWorkerMain,
    { id: string; event: RequestEvent }
  >();
  private readonly commandSubscribers = new Map<
    WebFrameMain | ServiceWorkerMain,
    { id: string; event: RequestEvent }
  >();
  private readonly browserEventSubscribers = new Map<
    WebFrameMain | ServiceWorkerMain,
    { id: string; event: RequestEvent; permissions: Set<string> }
  >();
  private readonly actionSubscribers = new Map<
    WebFrameMain | ServiceWorkerMain,
    { id: string; event: RequestEvent }
  >();
  private readonly tabCreators = new Map<number, string>();
  private groups = new Map<number, Group>();
  private membership = new Map<number, number>();
  private nextId = 1;
  private frames = new Set<WebContents>();
  private workers = new Set<ServiceWorkerMain>();
  private subscribers = new Map<
    WebFrameMain | ServiceWorkerMain,
    { id: string; event: RequestEvent }
  >();
  private watched = new Map<WebContents, () => void>();
  private preloads: string[] = [];
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
    worker.ipc.handle(CHANNEL, (event, method, args) => this.handle(event, method, args));
  };
  constructor(private options: Options) {
    this.registerPreload();
    app.on('web-contents-created', this.onContents);
    for (const contents of webContents.getAllWebContents()) this.attach(contents);
    options.session.serviceWorkers.on('running-status-changed', this.onWorker);
    for (const version of Object.keys(options.session.serviceWorkers.getAllRunning()))
      this.onWorker({ versionId: Number(version), runningStatus: 'running' });
  }
  private registerPreload() {
    for (const type of ['frame', 'service-worker'] as const)
      this.preloads.push(
        this.options.session.registerPreloadScript({ type, filePath: this.options.preload }),
      );
  }
  private attach(contents: WebContents) {
    if (contents.session !== this.options.session || this.frames.has(contents)) return;
    this.frames.add(contents);
    contents.ipc.handle(CHANNEL, (event, method, args) => this.handle(event, method, args));
    contents.once('destroyed', () => this.frames.delete(contents));
    contents.on('context-menu', (_event, params) => {
      const items = this.contextMenuItems(contents, params);
      if (items.length) Menu.buildFromTemplate(items).popup({ window: this.options.parent() });
    });
  }
  private caller(event: RequestEvent): string {
    let url: string;
    if (event.type === 'service-worker') {
      const worker = event.serviceWorker;
      if (
        event.session !== this.options.session ||
        worker.isDestroyed() ||
        this.options.session.serviceWorkers.getWorkerFromVersionID(event.versionId) !== worker
      )
        throw new Error('Untrusted tabGroups worker.');
      const scope = new URL(worker.scope);
      const script = new URL(worker.scriptURL);
      if (
        scope.protocol !== 'chrome-extension:' ||
        scope.host !== script.host ||
        scope.protocol !== script.protocol
      )
        throw new Error('Invalid tabGroups worker scope.');
      url = worker.scriptURL;
    } else {
      if (
        event.sender.session !== this.options.session ||
        !event.senderFrame ||
        event.sender.isDestroyed?.()
      )
        throw new Error('Untrusted tabGroups frame.');
      url = event.senderFrame.url;
    }
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'chrome-extension:' ||
      !/^[a-p]{32}$/.test(parsed.hostname) ||
      !this.options.session.extensions.getExtension(parsed.hostname)
    )
      throw new Error('tabGroups is only available to installed extension contexts.');
    return parsed.hostname;
  }
  private permitted(id: string, permission = 'tabGroups') {
    return (
      this.options.session.extensions
        .getExtension(id)
        ?.manifest.permissions?.includes(permission) === true
    );
  }
  private object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid tabGroups options.');
    return value as Record<string, unknown>;
  }
  private group(value: unknown): Group {
    if (!Number.isInteger(value) || !this.groups.has(value as number))
      throw new Error('No group with this ID.');
    return this.groups.get(value as number)!;
  }
  private tabIds(value: unknown): number[] {
    const ids = Array.isArray(value) ? value : [value];
    const tabs = this.options
      .tabs()
      .filter((tab) => tab.session === this.options.session && !tab.isDestroyed());
    if (
      !ids.length ||
      ids.some((id) => !Number.isInteger(id) || !tabs.some((tab) => tab.id === id))
    )
      throw new Error('Invalid or unavailable native tab ID.');
    return [...new Set(ids)] as number[];
  }
  private emit(name: string, group: Group) {
    for (const [target, subscriber] of this.subscribers) {
      try {
        if (this.caller(subscriber.event) !== subscriber.id || !this.permitted(subscriber.id)) {
          this.subscribers.delete(target);
          continue;
        }
        target.send(EVENTS, name, { ...group });
      } catch {
        this.subscribers.delete(target);
      }
    }
  }
  private prune(groupId: number) {
    if ([...this.membership.values()].includes(groupId)) return;
    const group = this.groups.get(groupId);
    if (group) {
      this.groups.delete(groupId);
      this.emit('onRemoved', group);
    }
  }
  private watch(id: number) {
    const tab = this.options.tabs().find((item) => item.id === id)!;
    if (this.watched.has(tab)) return;
    const closed = () => {
      const groupId = this.membership.get(id);
      this.membership.delete(id);
      this.tabCreators.delete(id);
      this.watched.delete(tab);
      if (groupId !== undefined) {
        this.prune(groupId);
        this.options.onChange?.();
      }
    };
    this.watched.set(tab, closed);
    tab.once('destroyed', closed);
  }
  groupIdFor(tabId: number): number {
    return this.membership.get(tabId) ?? -1;
  }
  dispatchCommand(contents: WebContents, input: Input): boolean {
    if (input.type !== 'keyDown' || input.isAutoRepeat || !this.options.tabs().includes(contents))
      return false;
    const key = /^Key([A-Z])$/.exec(input.code)?.[1] ?? (input.code === 'Period' ? 'Period' : '');
    if (!key) return false;
    const pressed = new Set([
      key,
      ...(input.alt ? ['Alt'] : []),
      ...(input.control ? [process.platform === 'darwin' ? 'MacCtrl' : 'Ctrl'] : []),
      ...(input.meta ? ['Command'] : []),
      ...(input.shift ? ['Shift'] : []),
    ]);
    if (pressed.size < 2) return false;
    const platform =
      ({ darwin: 'mac', win32: 'windows' } as Record<string, string>)[process.platform] ?? 'linux';
    const matches = this.options.session.extensions.getAllExtensions().flatMap((extension) => {
      const commands = (extension.manifest.commands ?? {}) as Record<
        string,
        { suggested_key?: Record<string, string>; global?: boolean }
      >;
      return Object.entries(commands).flatMap(([name, command]) => {
        const shortcut = command.suggested_key?.[platform] ?? command.suggested_key?.default;
        if (command.global || !shortcut) return [];
        const parts = shortcut
          .split('+')
          .map((part) => (process.platform === 'darwin' && part === 'Ctrl' ? 'Command' : part));
        return parts.length === pressed.size && parts.every((part) => pressed.has(part))
          ? [{ id: extension.id, name }]
          : [];
      });
    });
    // Keep Pilion's shortcuts and leave ambiguous extension shortcuts unassigned.
    if (matches.length !== 1) return false;
    const { id, name } = matches[0];
    if (name === '_execute_action') {
      if (!this.options.openAction) return false;
      void this.options
        .openAction(id)
        .catch((error) => console.error('打开扩展快捷命令失败', error));
      return true;
    }
    void this.dispatchExtensionCommand(id, name);
    return true;
  }

  private async dispatchExtensionCommand(id: string, name: string): Promise<void> {
    if (this.options.session.extensions.getExtension(id)?.manifest.background?.service_worker) {
      try {
        await this.options.session.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`);
      } catch {
        // Extension pages may still be listening.
      }
    }
    for (const [target, subscriber] of this.commandSubscribers) {
      if (subscriber.id !== id) continue;
      try {
        if (this.caller(subscriber.event) !== id) throw new Error('Extension context changed.');
        target.send(EVENTS, 'commands.onCommand', name);
      } catch {
        this.commandSubscribers.delete(target);
      }
    }
  }

  contextMenuItems(contents: WebContents, params: ContextMenuParams) {
    if (contents.isDestroyed() || !this.options.tabs().includes(contents)) return [];
    return this.contextMenus.items(
      params,
      (id) => this.permitted(id, 'contextMenus'),
      async (id, info) => {
        if (!this.permitted(id, 'contextMenus')) return;
        const send = () => {
          let delivered = false;
          for (const [target, subscriber] of this.menuSubscribers) {
            if (subscriber.id !== id) continue;
            try {
              if (this.caller(subscriber.event) !== id)
                throw new Error('Extension context changed.');
              target.send(EVENTS, 'contextMenus.onClicked', info);
              delivered = true;
            } catch {
              this.menuSubscribers.delete(target);
            }
          }
          return delivered;
        };
        const worker =
          this.options.session.extensions.getExtension(id)?.manifest.background?.service_worker;
        if (worker) {
          try {
            await this.options.session.serviceWorkers.startWorkerForScope(
              `chrome-extension://${id}/`,
            );
          } catch {
            // MV2 and frame listeners can still receive the click.
          }
        }
        send();
      },
    );
  }
  async dispatchAction(id: string, details: Record<string, unknown>): Promise<boolean> {
    if (this.options.session.extensions.getExtension(id)?.manifest.background?.service_worker) {
      try {
        await this.options.session.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`);
      } catch {
        // A running extension page may still be listening.
      }
    }
    let delivered = false;
    for (const [target, subscriber] of this.actionSubscribers) {
      if (subscriber.id !== id) continue;
      try {
        if (this.caller(subscriber.event) !== id) throw new Error('Extension context changed.');
        target.send(EVENTS, 'action.onClicked', details);
        delivered = true;
      } catch {
        this.actionSubscribers.delete(target);
      }
    }
    return delivered;
  }

  tabCompleted(tabId: number, url: string, title: string): void {
    if (!this.options.tabs().some((tab) => tab.id === tabId && !tab.isDestroyed())) return;
    this.emitBrowserEvent('tabs.onUpdated', [
      tabId,
      { status: 'complete' },
      {
        id: tabId,
        url,
        title,
        status: 'complete',
        windowId: this.options.parent().id,
        groupId: this.groupIdFor(tabId),
      },
    ]);
  }

  emitBrowserEvent(name: BrowserEvent, details: Record<string, unknown> | unknown[]): void {
    const permission = name.split('.')[0];
    for (const [target, subscriber] of this.browserEventSubscribers) {
      if (!subscriber.permissions.has(permission) || !this.permitted(subscriber.id, permission))
        continue;
      try {
        if (this.caller(subscriber.event) !== subscriber.id)
          throw new Error('Extension context changed.');
        target.send(EVENTS, name, details);
      } catch {
        this.browserEventSubscribers.delete(target);
      }
    }
  }
  async handle(event: RequestEvent, method: unknown, raw: unknown): Promise<unknown> {
    const id = this.caller(event);
    if (!Array.isArray(raw)) throw new Error('Invalid tabGroups arguments.');
    const args: unknown[] = raw;
    if (
      method === 'downloads.subscribe' ||
      method === 'webNavigation.subscribe' ||
      method === 'tabs.subscribe'
    ) {
      const permission = method.split('.')[0];
      if (!this.permitted(id, permission))
        throw new Error(`Extension ${permission} permission required.`);
      const target = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
      const permissions = this.browserEventSubscribers.get(target)?.permissions ?? new Set();
      permissions.add(permission);
      this.browserEventSubscribers.set(target, { event, id, permissions });
      return;
    }
    if (method === 'action.subscribe') {
      const target = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
      this.actionSubscribers.set(target, { id, event });
      return;
    }
    if (method === 'commands.subscribe') {
      const target = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
      this.commandSubscribers.set(target, { id, event });
      return;
    }
    if (method === 'tabs.getUiMetadata') {
      const [tabId] = this.tabIds(args[0]);
      return { windowId: this.options.parent().id, groupId: this.groupIdFor(tabId) };
    }
    if (method === 'tabs.createWeb') {
      const details = this.object(args[0]);
      const url = typeof details.url === 'string' ? URL.parse(details.url) : null;
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Expected an HTTP(S) web URL.');
      if (details.active !== undefined && typeof details.active !== 'boolean')
        throw new Error('Invalid tab activation flag.');
      if (
        details.windowId !== undefined &&
        ![0, -2, this.options.parent().id].includes(Number(details.windowId))
      )
        throw new Error('Unknown browser window.');
      if (!this.options.openWebTab) throw new Error('Opening browser tabs is unavailable.');
      const tab = await this.options.openWebTab(url.href, details.active !== false);
      this.tabCreators.set(tab.id, id);
      this.watch(tab.id);
      return tab;
    }
    if (method === 'tabs.removeOwned') {
      const ids = this.tabIds(args[0]);
      if (!this.options.closeWebTab || ids.some((tabId) => this.tabCreators.get(tabId) !== id))
        throw new Error('Extensions can close only their own created browser tabs.');
      for (const tabId of ids) await this.options.closeWebTab(tabId);
      return;
    }
    if (method === 'windows.getCurrent') {
      const window = this.options.parent();
      return {
        id: window.id,
        type: 'normal',
        incognito: false,
        focused: window.isFocused?.() ?? false,
      };
    }
    if (typeof method === 'string' && method.startsWith('contextMenus.')) {
      if (!this.permitted(id, 'contextMenus'))
        throw new Error('This extension does not have the contextMenus permission.');
      if (method === 'contextMenus.subscribe') {
        const target = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
        this.menuSubscribers.set(target, { id, event });
      } else if (method === 'contextMenus.removeAll') this.contextMenus.clear(id);
      else if (method === 'contextMenus.update')
        this.contextMenus.update(id, args[0], this.object(args[1]));
      else if (method === 'contextMenus.remove') this.contextMenus.remove(id, args[0]);
      else if (method === 'contextMenus.create') this.contextMenus.create(id, this.object(args[0]));
      else throw new Error('Unsupported context menu operation.');
      return;
    }
    // Chrome tabs.group/ungroup are tabs namespace operations; the tabs permission only gates sensitive Tab properties.
    if (method !== 'tabs.group' && method !== 'tabs.ungroup' && !this.permitted(id))
      throw new Error('This extension does not have the tabGroups permission.');
    if (method === 'subscribe') {
      const target = event.type === 'service-worker' ? event.serviceWorker : event.senderFrame!;
      this.subscribers.set(target, { id, event });
      return;
    }
    if (method === 'tabs.group') {
      const details = this.object(args[0]);
      const ids = this.tabIds(details.tabIds);
      if (details.groupId !== undefined && details.createProperties !== undefined)
        throw new Error('groupId and createProperties are mutually exclusive.');
      let group: Group;
      let created = false;
      if (details.groupId !== undefined) group = this.group(details.groupId);
      else {
        const create =
          details.createProperties === undefined ? {} : this.object(details.createProperties);
        if (
          create.windowId !== undefined &&
          create.windowId !== -2 &&
          create.windowId !== this.options.parent().id
        )
          throw new Error('Cannot group tabs in another window.');
        group = {
          id: this.nextId++,
          windowId: this.options.parent().id,
          title: '',
          color: 'grey',
          collapsed: false,
          shared: false,
        };
        this.groups.set(group.id, group);
        created = true;
      }
      const old = new Set<number>();
      for (const tabId of ids) {
        const previous = this.membership.get(tabId);
        if (previous !== undefined) old.add(previous);
        this.membership.set(tabId, group.id);
        this.watch(tabId);
      }
      for (const previous of old) this.prune(previous);
      if (created) this.emit('onCreated', group);
      this.options.onChange?.();
      return group.id;
    }
    if (method === 'tabs.ungroup') {
      const ids = this.tabIds(args[0]);
      const old = new Set<number>();
      for (const tabId of ids) {
        const previous = this.membership.get(tabId);
        if (previous !== undefined) old.add(previous);
        this.membership.delete(tabId);
      }
      for (const previous of old) this.prune(previous);
      this.options.onChange?.();
      return;
    }
    if (method === 'get') return { ...this.group(args[0]) };
    if (method === 'query') {
      const query = this.object(args[0] ?? {});
      for (const key of Object.keys(query))
        if (!['windowId', 'title', 'color', 'collapsed', 'shared'].includes(key))
          throw new Error('Unsupported group query property.');
      if (query.title !== undefined && typeof query.title !== 'string')
        throw new Error('Invalid title.');
      if (query.color !== undefined && !COLORS.includes(query.color as string))
        throw new Error('Invalid group color.');
      for (const key of ['collapsed', 'shared'])
        if (query[key] !== undefined && typeof query[key] !== 'boolean')
          throw new Error('Invalid group query.');
      if (query.windowId !== undefined && !Number.isInteger(query.windowId))
        throw new Error('Invalid window ID.');
      const title =
        typeof query.title === 'string'
          ? new RegExp(
              `^${query.title
                .split('*')
                .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('.*')}$`,
            )
          : undefined;
      return [...this.groups.values()]
        .filter((group) =>
          Object.entries(query).every(([key, value]) =>
            key === 'title'
              ? title!.test(group.title)
              : key === 'windowId' && value === -2
                ? group.windowId === this.options.parent().id
                : group[key as keyof Group] === value,
          ),
        )
        .map((group) => ({ ...group }));
    }
    if (method === 'update') {
      const group = this.group(args[0]);
      const update = this.object(args[1]);
      for (const key of Object.keys(update))
        if (!['title', 'color', 'collapsed'].includes(key))
          throw new Error('Unsupported group update property.');
      if (update.title !== undefined && typeof update.title !== 'string')
        throw new Error('Invalid title.');
      if (update.collapsed !== undefined && typeof update.collapsed !== 'boolean')
        throw new Error('Invalid collapsed state.');
      if (update.color !== undefined && !COLORS.includes(update.color as string))
        throw new Error('Invalid group color.');
      const changed = Object.entries(update).some(
        ([key, value]) => group[key as keyof Group] !== value,
      );
      Object.assign(group, update);
      if (changed) {
        this.emit('onUpdated', group);
        this.options.onChange?.();
      }
      return { ...group };
    }
    if (method === 'move') {
      const group = this.group(args[0]);
      const move = this.object(args[1]);
      if (!Number.isInteger(move.index) || (move.index as number) < -1)
        throw new Error('Invalid group move index.');
      if (move.windowId !== undefined && move.windowId !== -2 && move.windowId !== group.windowId)
        throw new Error('Moving groups across windows is unsupported.');
      if (!this.options.moveTabs) throw new Error('Native tab reordering is unavailable.');
      const members = this.options
        .tabs()
        .filter((tab) => this.membership.get(tab.id) === group.id)
        .map((tab) => tab.id);
      await this.options.moveTabs(members, move.index as number);
      this.emit('onMoved', group);
      this.options.onChange?.();
      return { ...group };
    }
    throw new Error(`Unsupported tabGroups method: ${String(method)}`);
  }
  dispose() {
    app.removeListener('web-contents-created', this.onContents);
    this.options.session.serviceWorkers.removeListener('running-status-changed', this.onWorker);
    for (const contents of this.frames)
      if (!contents.isDestroyed()) contents.ipc.removeHandler(CHANNEL);
    for (const worker of this.workers) if (!worker.isDestroyed()) worker.ipc.removeHandler(CHANNEL);
    for (const [tab, listener] of this.watched)
      if (!tab.isDestroyed()) tab.removeListener('destroyed', listener);
    for (const id of this.preloads) this.options.session.unregisterPreloadScript(id);
    this.subscribers.clear();
    this.menuSubscribers.clear();
    this.commandSubscribers.clear();
    this.browserEventSubscribers.clear();
    this.actionSubscribers.clear();
    this.watched.clear();
    this.groups.clear();
    this.membership.clear();
    this.tabCreators.clear();
  }
}
