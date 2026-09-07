import { createHash } from 'node:crypto';
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import type {
  BrowserEffect,
  BrowserPageFactory,
  BrowserPagePort,
  PageLifecycleEvent,
  PageObservedElement,
  PageSnapshot,
} from './types.js';
import { PRESS_KEYS } from './types.js';
import { BrowserError } from './errors.js';

const SELECTOR = 'a,button,input,textarea,select,[role]';

type CdpNode = {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  parentId?: number;
  attributes?: string[];
  children?: CdpNode[];
};
type CdpResult<T> = T;

/** Fixed-command CDP adapter. No caller-controlled script or raw protocol command crosses this boundary. */
export class ElectronPagePort implements BrowserPagePort {
  private listener: (event: PageLifecycleEvent) => void = () => undefined;
  private closed = false;
  private readonly allowedNavigations = new Set<string>();

  constructor(
    readonly view: WebContentsView,
    private readonly parent: BrowserWindow,
    private readonly validateUrl: (url: string) => Promise<string>,
  ) {
    const wc = view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.on('did-frame-navigate', (_event, _url, _httpCode, _httpStatus, isMainFrame) => {
      this.listener(
        isMainFrame
          ? { kind: 'document-committed' }
          : { kind: 'frame-committed', frameId: 'subframe' },
      );
    });
    wc.on('destroyed', () => {
      this.closed = true;
      this.listener({ kind: 'destroyed' });
    });
    hardenUntrustedContents(wc, (url) => this.guardNavigation(url));
  }

  async snapshot(): Promise<PageSnapshot> {
    const wc = this.view.webContents;
    return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() };
  }

  async readText(): Promise<string> {
    const result = await this.command<{
      nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
    }>('Accessibility.getFullAXTree', {});
    return result.nodes
      .filter((node) => !node.ignored && ['StaticText', 'heading'].includes(node.role?.value ?? ''))
      .map((node) => node.name?.value ?? '')
      .join('\n')
      .slice(0, 60_000);
  }

  async navigate(canonicalUrl: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const validated = await this.validateUrl(canonicalUrl);
    this.allowedNavigations.add(navigationKey(validated));
    const stop = () => this.view.webContents.stop();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await this.view.webContents.loadURL(validated);
      throwIfAborted(signal);
    } finally {
      signal?.removeEventListener('abort', stop);
      this.allowedNavigations.delete(navigationKey(validated));
    }
  }

  async observeElements(signal?: AbortSignal): Promise<ReadonlyArray<PageObservedElement>> {
    throwIfAborted(signal);
    const root = await this.command<{ root: CdpNode }>(
      'DOM.getDocument',
      { depth: 0, pierce: false },
      signal,
    );
    const found = await this.command<{ nodeIds: number[] }>(
      'DOM.querySelectorAll',
      { nodeId: root.root.nodeId, selector: SELECTOR },
      signal,
    );
    const rows: PageObservedElement[] = [];
    for (const nodeId of found.nodeIds.slice(0, 200)) {
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId, depth: 3 },
        signal,
      );
      const attrs = attributes(described.node.attributes ?? []);
      const outer = await this.command<{ outerHTML: string }>(
        'DOM.getOuterHTML',
        { nodeId },
        signal,
      );
      const semantic = await this.semanticDetails(described.node, attrs, signal);
      const tagName = described.node.nodeName.toLowerCase();
      const optionValues = tagName === 'select' ? selectOptionValues(described.node) : undefined;
      rows.push({
        elementKey: String(nodeId),
        frameId: 'main',
        localFingerprint: elementFingerprint(outer.outerHTML, semantic.checked),
        role: semantic.role,
        name: semantic.name,
        disabled: Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true',
        tagName,
        inputType: semantic.inputType,
        formAction: semantic.formAction,
        optionValues,
        checked: semantic.checked,
      });
    }
    return rows;
  }

  async elementFingerprint(
    frameId: string,
    elementKey: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    throwIfAborted(signal);
    if (frameId !== 'main') return undefined;
    try {
      const id = nodeId(elementKey);
      const result = await this.command<{ outerHTML: string }>(
        'DOM.getOuterHTML',
        { nodeId: id },
        signal,
      );
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: id, depth: 0 },
        signal,
      );
      const semantic = await this.semanticDetails(
        described.node,
        attributes(described.node.attributes ?? []),
        signal,
      );
      return elementFingerprint(result.outerHTML, semantic.checked);
    } catch {
      return undefined;
    }
  }

  async applyEffect(
    frameId: string,
    elementKey: string,
    effect: BrowserEffect,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (frameId !== 'main')
      throw new BrowserError(
        'UNSUPPORTED_ELEMENT',
        'Only observed main-frame elements are supported',
      );
    const id = nodeId(elementKey);
    const described = await this.command<{ node: CdpNode }>(
      'DOM.describeNode',
      { nodeId: id, depth: 3 },
      signal,
    );
    const attrs = attributes(described.node.attributes ?? []);
    const tagName = described.node.nodeName.toLowerCase();
    if (Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true') {
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'Effect target is disabled');
    }
    if (effect.kind === 'type') {
      await this.command('DOM.focus', { nodeId: id }, signal);
      if (effect.replace !== false) {
        await this.command(
          'Input.dispatchKeyEvent',
          { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 },
          signal,
        );
        await this.command(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 },
          signal,
        );
      }
      await this.command('Input.insertText', { text: effect.text }, signal);
      return;
    }
    if (effect.kind === 'press') {
      if (
        !PRESS_KEYS.includes(effect.key) ||
        !Array.isArray(effect.modifiers) ||
        effect.modifiers.length > 1 ||
        effect.modifiers.some((modifier) => modifier !== 'Shift')
      ) {
        throw new BrowserError(
          'KEY_NOT_ALLOWED',
          'Key or modifier is not in the browser.press allowlist',
        );
      }
      await this.command('DOM.focus', { nodeId: id }, signal);
      await this.dispatchKey(effect.key, effect.modifiers.includes('Shift') ? 8 : 0, signal);
      return;
    }
    if (effect.kind === 'select') {
      if (tagName !== 'select')
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.select requires a <select> target');
      const options = selectOptionValues(described.node);
      const optionIndex = options.indexOf(effect.value);
      if (optionIndex < 0)
        throw new BrowserError(
          'OPTION_NOT_FOUND',
          'Requested option does not exist in the current <select>',
        );
      await this.command('DOM.focus', { nodeId: id }, signal);
      await this.dispatchKey('Home', 0, signal);
      for (let index = 0; index < optionIndex; index += 1)
        await this.dispatchKey('ArrowDown', 0, signal);
      await this.dispatchKey('Enter', 0, signal);
      return;
    }
    if (effect.kind === 'check') {
      const inputType = tagName === 'input' ? (attrs.type || 'text').toLowerCase() : '';
      if (!['checkbox', 'radio'].includes(inputType))
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.check requires a checkbox or radio');
      if (inputType === 'radio' && !effect.checked)
        throw new BrowserError(
          'UNSUPPORTED_ELEMENT',
          'A radio control cannot be unchecked directly',
        );
      const semantic = await this.semanticDetails(described.node, attrs, signal);
      if (semantic.checked === effect.checked) return;
      if (semantic.checked === undefined)
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'Current checked state is unavailable');
    }
    await this.clickNode(id, signal);
  }

  setLifecycleListener(listener: (event: PageLifecycleEvent) => void): void {
    this.listener = listener;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.view.webContents.debugger.isAttached()) this.view.webContents.debugger.detach();
    try {
      this.parent.contentView.removeChildView(this.view);
    } catch {
      /* parent may already be closing */
    }
    this.view.webContents.close();
  }

  private guardNavigation(url: string): boolean {
    const key = navigationKey(url);
    if (this.allowedNavigations.delete(key)) return true;
    void this.validateUrl(url)
      .then((canonical) => this.navigate(canonical))
      .catch(() => {
        // Navigation remains cancelled: URL policy failures are fail-closed.
      });
    return false;
  }

  private async semanticDetails(
    node: CdpNode,
    attrs: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{
    role: string;
    name: string;
    inputType?: string;
    formAction?: string;
    checked?: boolean;
  }> {
    let role = attrs.role || inferredRole(node.nodeName, attrs) || '';
    let name = attrs['aria-label'] || attrs.alt || attrs.title || attrs.placeholder || '';
    let checked: boolean | undefined;
    try {
      const ax = await this.command<{
        nodes?: Array<{
          role?: { value?: string };
          name?: { value?: string };
          properties?: Array<{ name?: string; value?: { value?: unknown } }>;
        }>;
      }>('Accessibility.getPartialAXTree', { nodeId: node.nodeId, fetchRelatives: false }, signal);
      role = role || ax.nodes?.[0]?.role?.value || '';
      name = name || ax.nodes?.[0]?.name?.value || '';
      const checkedValue = ax.nodes?.[0]?.properties?.find(
        (property) => property.name === 'checked',
      )?.value?.value;
      if (checkedValue === true || checkedValue === 'true') checked = true;
      else if (checkedValue === false || checkedValue === 'false') checked = false;
    } catch {
      /* AX may be unavailable during navigation. */
    }
    const inputType =
      node.nodeName.toLowerCase() === 'input' ? (attrs.type || 'text').toLowerCase() : undefined;
    const rawAction =
      attrs.formaction ||
      (await this.findAncestorAttribute(node.parentId, 'form', 'action', signal));
    let formAction: string | undefined;
    if (rawAction) {
      try {
        formAction = new URL(rawAction, this.view.webContents.getURL()).toString();
      } catch {
        formAction = rawAction.slice(0, 500);
      }
    }
    return { role, name: name.trim().slice(0, 200), inputType, formAction, checked };
  }

  private async findAncestorAttribute(
    parentId: number | undefined,
    tag: string,
    attribute: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    let current = parentId;
    for (let depth = 0; current && depth < 32; depth += 1) {
      const row = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: current, depth: 0 },
        signal,
      );
      const attrs = attributes(row.node.attributes ?? []);
      if (row.node.nodeName.toLowerCase() === tag) return attrs[attribute];
      current = row.node.parentId;
    }
    return undefined;
  }

  private async clickNode(id: number, signal?: AbortSignal): Promise<void> {
    const box = await this.command<{ model: { content: number[] } }>(
      'DOM.getBoxModel',
      { nodeId: id },
      signal,
    );
    const q = box.model.content;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
      signal,
    );
    await this.command(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
      signal,
    );
  }

  private async dispatchKey(
    key: (typeof PRESS_KEYS)[number],
    modifiers: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const protocol = keyDetails(key);
    await this.command(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', ...protocol, modifiers },
      signal,
    );
    await this.command('Input.dispatchKeyEvent', { type: 'keyUp', ...protocol, modifiers }, signal);
  }

  private async command<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CdpResult<T>> {
    throwIfAborted(signal);
    const result = (await this.view.webContents.debugger.sendCommand(method, params)) as T;
    throwIfAborted(signal);
    return result;
  }
}

export class ElectronPageFactory implements BrowserPageFactory {
  readonly pages: ElectronPagePort[] = [];
  constructor(
    private readonly window: BrowserWindow,
    private readonly onCreated: (page: ElectronPagePort) => void,
    private readonly validateUrl: (url: string) => Promise<string>,
  ) {}

  async create(canonicalUrl: string): Promise<BrowserPagePort> {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        partition: 'persist:pilion-default',
      },
    });
    const page = new ElectronPagePort(view, this.window, this.validateUrl);
    this.pages.push(page);
    this.window.contentView.addChildView(view);
    this.onCreated(page);
    try {
      await page.navigate(canonicalUrl);
    } catch (error) {
      await page.close();
      this.pages.splice(this.pages.indexOf(page), 1);
      throw error;
    }
    return page;
  }
}

export function hardenUntrustedContents(
  contents: WebContents,
  allowNavigation: (url: string) => boolean,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event: Electron.Event, url: string) => {
    if (!allowNavigation(url)) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function navigationKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function nodeId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('无效的内部元素引用');
  return parsed;
}
function attributes(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 2) result[values[i]] = values[i + 1] ?? '';
  return result;
}
function elementFingerprint(outerHtml: string, checked: boolean | undefined): string {
  return createHash('sha256')
    .update(`${outerHtml}\nchecked:${checked === undefined ? 'na' : String(checked)}`)
    .digest('hex');
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Browser operation revoked');
}
function inferredRole(nodeName: string, attrs: Record<string, string>): string | undefined {
  const tag = nodeName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && attrs.href) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'input') {
    const type = (attrs.type || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'textbox';
  }
  return undefined;
}

function selectOptionValues(select: CdpNode): string[] {
  const values: string[] = [];
  const visit = (node: CdpNode, ancestorDisabled = false): void => {
    const tagName = node.nodeName.toLowerCase();
    const attrs = attributes(node.attributes ?? []);
    const disabled = ancestorDisabled || Object.hasOwn(attrs, 'disabled');
    if (tagName === 'option') {
      if (disabled) return;
      const text = (node.children ?? [])
        .map((child) => child.nodeValue ?? '')
        .join('')
        .trim();
      values.push(Object.hasOwn(attrs, 'value') ? attrs.value : text);
      return;
    }
    for (const child of node.children ?? []) visit(child, disabled);
  };
  for (const child of select.children ?? []) visit(child);
  return values;
}

function keyDetails(key: (typeof PRESS_KEYS)[number]): { key: string; code: string } {
  if (key === 'Space') return { key: ' ', code: 'Space' };
  const codes: Record<(typeof PRESS_KEYS)[number], string> = {
    Enter: 'Enter',
    Escape: 'Escape',
    Tab: 'Tab',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Space: 'Space',
  };
  return { key, code: codes[key] };
}
