import { createHash } from 'node:crypto';
import { BrowserWindow, WebContentsView, type WebContents } from 'electron';
import type {
  ActionEffect,
  BrowserEffect,
  BrowserPageFactory,
  BrowserPagePort,
  PageLifecycleEvent,
  PageObservedElement,
  PageScreenshot,
  PageSnapshot,
  ScreenshotOptions,
  UploadReceipt,
} from './types.js';
import { ACTIVE_ELEMENT_KEY, OBSERVE_SELECTOR, PRESS_KEYS } from './types.js';
import { BrowserError } from './errors.js';
import { AgentPointer } from './agent-pointer.js';
import { recordableText, type AxTextNode } from './recordable-text.js';
import {
  RecordingChannel,
  type RecordingChannelOptions,
  type CdpLike,
  type CdpListener,
} from './recording-channel.js';

type CdpNode = {
  nodeId: number;
  nodeName: string;
  nodeValue?: string;
  parentId?: number;
  attributes?: string[];
  children?: CdpNode[];
};
type CdpResult<T> = T;
type ElementSemantics = {
  role: string;
  name: string;
  inputType?: string;
  buttonType?: string;
  href?: string;
  formAction?: string;
  checked?: boolean;
  pressed?: boolean | 'mixed';
  /** 带 click handler 的无语义元素被纳入 observe 的原因（issue #3）。 */
  clickSource?: string;
};
type NativeControlState = {
  value?: string;
  valueTruncated?: true;
  checked?: boolean;
};
type PageState = { active: string; url: string; body: string };

/** 固定脚本：读取轻量页面状态指纹，用于 press 前后对比，区分 dispatched 与 actually activated。 */
const READ_PAGE_STATE = `function() {
  const doc = this.ownerDocument || (this.nodeType === 9 ? this : null);
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return null;
  let active = '';
  try { const a = d.activeElement; if (a) active = [a.tagName, (a.getAttribute && a.getAttribute('id')) || '', (a.getAttribute && a.getAttribute('aria-label')) || ''].join('|'); } catch {}
  let url = ''; try { url = d.location ? d.location.href : ''; } catch {}
  let body = ''; try { const b = d.body; if (b) body = [b.childNodes.length, (b.textContent || '').length, b.querySelectorAll ? b.querySelectorAll('*').length : 0].join(':'); } catch {}
  return { active, url, body };
}`;
/** 固定脚本：force 路径复用 check 的原生 click 激活，绕过覆盖/无布局的指针命中检测。 */
const FORCE_CLICK = `function() {
  if (this.disabled || this.getAttribute('aria-disabled') === 'true') throw new Error('disabled');
  if (typeof HTMLElement !== 'undefined' && this instanceof HTMLElement) HTMLElement.prototype.click.call(this);
  else if (typeof this.click === 'function') this.click();
  else throw new Error('not clickable');
  return true;
}`;

/** press 前后状态比较：检测不到时只报 dispatched，绝不裸 {ok:true}（issue #3）。 */
function pressEffect(before: PageState | null, after: PageState | null): ActionEffect {
  if (!before || !after)
    return { ok: true, effect: 'dispatched', detectedBy: 'page-state-unavailable' };
  const changed =
    before.active !== after.active || before.url !== after.url || before.body !== after.body;
  return { ok: true, effect: changed ? 'activated' : 'none', detectedBy: 'page-state' };
}
function isNoLayout(error: unknown): boolean {
  return error instanceof BrowserError && /no layout/i.test(error.message);
}

// Runs only on a resolved node in our isolated world. Read native prototype getters
// rather than page-defined properties, and cap before returning data through CDP.
const READ_NATIVE_CONTROL_STATE = `function() {
  let prototype;
  let checked;
  if (this instanceof HTMLInputElement) {
    prototype = HTMLInputElement.prototype;
    const type = Object.getOwnPropertyDescriptor(prototype, 'type').get.call(this);
    if (type === 'password') return {};
    if (type === 'checkbox' || type === 'radio')
      checked = Object.getOwnPropertyDescriptor(prototype, 'checked').get.call(this);
  } else if (this instanceof HTMLTextAreaElement) {
    prototype = HTMLTextAreaElement.prototype;
  } else if (this instanceof HTMLSelectElement) {
    prototype = HTMLSelectElement.prototype;
  } else return {};
  const value = Object.getOwnPropertyDescriptor(prototype, 'value').get.call(this);
  return {
    value: value.slice(0, 100000),
    ...(value.length > 100000 ? { valueTruncated: true } : {}),
    ...(checked === undefined ? {} : { checked })
  };
}`;

/** Runtime.callFunctionOn 回读 file input 的返回值形状（issue #4a）。 */
type ReadFileInputState = {
  fileCount: number;
  names: string[];
  accept: string;
  multiple: boolean;
  disabled: boolean;
  stillInDom: boolean;
  inputIndex: number;
  label: string;
  visible: boolean;
  bodyFingerprint: string;
};

/**
 * 回读 <input type=file> 的后验状态：文件数/文件名、accept/multiple/disabled、是否仍在 DOM、
 * 页面内第几个 file input、关联 label、是否可见，以及 document.body 的轻量指纹。
 * 固定脚本在隔离世界执行，页面 JS 看不到它，调用方也无法注入任意脚本。
 */
const READ_FILE_INPUT_STATE = `function() {
  const doc = this.ownerDocument;
  let label = '';
  try { if (this.labels) label = Array.from(this.labels).map((n) => (n.textContent || '').trim()).filter(Boolean).join(' '); } catch {}
  let visible = false;
  try { const r = this.getBoundingClientRect(); visible = !!(r && (r.width > 0 || r.height > 0)); } catch {}
  let bodyFingerprint = '';
  try {
    const body = doc && doc.body;
    if (body) bodyFingerprint = [body.childNodes.length, (body.textContent || '').length, body.querySelectorAll('*').length].join(':');
  } catch {}
  let inputIndex = -1;
  try { inputIndex = doc ? Array.from(doc.querySelectorAll('input[type=file]')).indexOf(this) : -1; } catch {}
  const names = [];
  let fileCount = 0;
  try {
    const fs = this.files;
    if (fs) { fileCount = fs.length; for (let i = 0; i < fs.length && names.length < 20; i += 1) names.push(String(fs[i].name).slice(0, 200)); }
  } catch {}
  let accept = ''; let multiple = false; let disabled = false; let stillInDom = true;
  try { accept = this.getAttribute('accept') || ''; } catch {}
  try { multiple = !!this.multiple; } catch {}
  try { disabled = !!this.disabled; } catch {}
  try { stillInDom = !doc || this.isConnected !== false; } catch {}
  return { fileCount, names, accept, multiple, disabled, stillInDom, inputIndex, label: label.slice(0, 200), visible, bodyFingerprint };
}`;

/** Chromium's own limit on a redirect chain. */
const MAX_REDIRECTS = 20;

/**
 * 1 MiB 响应帧里，图片 data 是 base64（约 4/3 膨胀），还要给 JSON envelope 留余量。
 * 700 KiB 解码字节 → 约 933 KiB base64 文本，稳稳落在 1 MiB 以内。
 * 超过预算就在主进程侧重编码/降采样，绝不让大图顶爆帧限制。
 */
const SCREENSHOT_BYTE_BUDGET = 700 * 1024;

interface ScreenshotSpec {
  format: 'png' | 'jpeg';
  quality?: number;
  scale?: number;
}

/** 自动降级链：先换 jpeg 降质量，再用 clip.scale 降分辨率。用户显式 clip 区域一直保留。 */
const SCREENSHOT_DOWNGRADES: ReadonlyArray<ScreenshotSpec> = [
  { format: 'jpeg', quality: 80 },
  { format: 'jpeg', quality: 60 },
  { format: 'jpeg', quality: 60, scale: 0.75 },
  { format: 'jpeg', quality: 60, scale: 0.5 },
];

/** 估算 base64 解码后的字节数，不分配与图片等大的 Buffer。 */
function base64DecodedBytes(data: string): number {
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Fixed-command CDP adapter. No caller-controlled script or raw protocol command crosses this boundary. */
export class ElectronPagePort implements BrowserPagePort {
  private listener: (event: PageLifecycleEvent) => void = () => undefined;
  private closed = false;
  private readonly allowedNavigations = new Set<string>();
  /** Set while navigate() waits on a load. It takes the redirect the guard cancels so navigate() can vet and follow it. */
  private claimRedirect?: (url: string) => void;

  constructor(
    readonly view: WebContentsView,
    private readonly parent: BrowserWindow,
    private readonly validateUrl: (url: string) => Promise<string>,
    private readonly pointer: AgentPointer = new AgentPointer(parent),
  ) {
    const wc = view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.on('did-frame-navigate', (_event, _url, _httpCode, _httpStatus, isMainFrame) => {
      if (isMainFrame) this.pointer.hideFor(view);
      this.listener(
        isMainFrame
          ? { kind: 'document-committed' }
          : { kind: 'frame-committed', frameId: 'subframe' },
      );
    });
    wc.on('destroyed', () => {
      this.pointer.hideFor(view);
      this.closed = true;
      this.listener({ kind: 'destroyed' });
    });
    hardenUntrustedContents(wc, (url, redirect) => this.guardNavigation(url, redirect));
  }

  async snapshot(): Promise<PageSnapshot> {
    const wc = this.view.webContents;
    return { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() };
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<PageScreenshot> {
    // Capture Chromium's page surface: capturePage can return cached pixels when
    // the person's home screen or an overlay keeps this background view hidden.
    const baseClip = opts.clip;
    let viewport: { width: number; height: number } | undefined;
    // 只有需要「覆盖整个视口的 clip.scale」时才读布局尺寸，避免普通截图多一次 CDP 往返。
    const getViewport = async (): Promise<{ width: number; height: number }> => {
      if (viewport) return viewport;
      const metrics = await this.command<{
        cssLayoutViewport?: { clientWidth: number; clientHeight: number };
        layoutViewport?: { clientWidth: number; clientHeight: number };
      }>('Page.getLayoutMetrics', undefined);
      const vp = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      viewport = { width: vp?.clientWidth ?? 800, height: vp?.clientHeight ?? 600 };
      return viewport;
    };

    const capture = async (spec: ScreenshotSpec): Promise<string> => {
      const params: Record<string, unknown> = {
        format: spec.format,
        fromSurface: true,
        captureBeyondViewport: false,
      };
      if (spec.format === 'jpeg' && spec.quality !== undefined) params.quality = spec.quality;
      if (baseClip) {
        params.clip = { ...baseClip, ...(spec.scale !== undefined ? { scale: spec.scale } : {}) };
      } else if (spec.scale !== undefined) {
        const vp = await getViewport();
        params.clip = { x: 0, y: 0, width: vp.width, height: vp.height, scale: spec.scale };
      }
      const image = await this.command<{ data: string }>('Page.captureScreenshot', params);
      return image.data;
    };

    const initial: ScreenshotSpec = {
      format: opts.format ?? 'png',
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    };
    let spec = initial;
    let downgraded = false;
    let data = await capture(spec);

    // 估算 base64 解码字节：超过预算就沿降级链重试，直到装得进 1 MiB 帧。
    if (base64DecodedBytes(data) > SCREENSHOT_BYTE_BUDGET) {
      for (const step of SCREENSHOT_DOWNGRADES) {
        // 用户显式 format/quality 被降级步骤覆盖；显式 scale/clip 尽量保留。
        spec = { ...initial, ...step };
        downgraded = true;
        data = await capture(spec);
        if (base64DecodedBytes(data) <= SCREENSHOT_BYTE_BUDGET) break;
      }
    }

    const mimeType = spec.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    if (!downgraded) return { mimeType, data };
    return {
      mimeType,
      data,
      downgraded: true,
      format: spec.format,
      ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
      ...(spec.scale !== undefined ? { scale: spec.scale } : {}),
    };
  }

  async readText(): Promise<string> {
    return (await this.readTextSnapshot()).text;
  }

  async readTextSnapshot(): Promise<{ text: string; textTruncated?: true }> {
    const result = await this.command<{
      nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
    }>('Accessibility.getFullAXTree', {});
    const text = result.nodes
      .filter((node) => !node.ignored && ['StaticText', 'heading'].includes(node.role?.value ?? ''))
      .map((node) => node.name?.value ?? '')
      .join('\n');
    return {
      text: text.slice(0, 60_000),
      ...(text.length > 60_000 ? { textTruncated: true } : {}),
    };
  }

  /** 录制摘录用这一份，规则见 recordable-text.ts；Agent 读页面仍走上面的 readText，看到的不变。 */
  async readRecordableText(): Promise<string> {
    const result = await this.command<{ nodes: AxTextNode[] }>('Accessibility.getFullAXTree', {});
    return recordableText(result.nodes);
  }

  async navigate(canonicalUrl: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let target = await this.validateUrl(canonicalUrl);
    const stop = () => this.view.webContents.stop();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for (let redirects = 0; ; redirects += 1) {
        const redirect = await this.loadHop(target);
        throwIfAborted(signal);
        if (redirect === undefined) return;
        if (redirects === MAX_REDIRECTS)
          throw new Error(`ERR_TOO_MANY_REDIRECTS (-310) loading '${canonicalUrl}'`);
        target = await this.validateUrl(redirect);
        throwIfAborted(signal);
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * 视口内合成一次滚轮事件。取布局视口中心作为坐标，避免依赖任何元素几何：
   * 目标元素可能在视口外（这正是需要滚动的原因）。
   */
  async scrollBy(direction: 'up' | 'down', amount?: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const metrics = await this.command<{
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      layoutViewport?: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics', undefined, signal);
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const width = viewport?.clientWidth ?? 800;
    const height = viewport?.clientHeight ?? 600;
    const step = Math.round(amount ?? height * 0.8);
    const deltaY = direction === 'down' ? step : -step;
    await this.command(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: Math.round(width / 2),
        y: Math.round(height / 2),
        deltaX: 0,
        deltaY,
      },
      signal,
    );
  }

  /** Loads one request of a navigation. Resolves with the redirect the guard cancelled it for, or undefined once it finished. */
  private async loadHop(target: string): Promise<string | undefined> {
    const contents = this.view.webContents;
    const key = navigationKey(target);
    const replaced = contents.getURL();
    let committed = false;
    const onCommit = (_event: unknown, url: string) => {
      if (navigationKey(url) === key) committed = true;
    };
    let claim: (url: string) => void = () => undefined;
    const redirected = new Promise<string>((resolve) => {
      claim = resolve;
    });
    this.allowedNavigations.add(key);
    this.claimRedirect = claim;
    contents.on('did-navigate', onCommit);
    try {
      // The cancelled load may never report back while the page it replaces is still loading.
      return await Promise.race([
        contents.loadURL(target).then(
          () => undefined,
          (error: unknown) => {
            if (committed && abortedReplacedPage(error, replaced)) return undefined;
            throw error;
          },
        ),
        redirected,
      ]);
    } finally {
      contents.off('did-navigate', onCommit);
      if (this.claimRedirect === claim) this.claimRedirect = undefined;
      this.allowedNavigations.delete(key);
    }
  }

  async observeElements(
    signal?: AbortSignal,
    offset = 0,
  ): Promise<ReadonlyArray<PageObservedElement>> {
    throwIfAborted(signal);
    const root = await this.command<{ root: CdpNode }>(
      'DOM.getDocument',
      { depth: 0, pierce: false },
      signal,
    );
    const found = await this.command<{ nodeIds: number[] }>(
      'DOM.querySelectorAll',
      { nodeId: root.root.nodeId, selector: OBSERVE_SELECTOR },
      signal,
    );
    const rows: PageObservedElement[] = [];
    for (const nodeId of found.nodeIds.slice(offset, offset + 200)) {
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId, depth: 3 },
        signal,
      );
      const attrs = attributes(described.node.attributes ?? []);
      const native = await this.nativeControlState(described.node, attrs, signal);
      const semantic = await this.semanticDetails(described.node, attrs, signal, native);
      const tagName = described.node.nodeName.toLowerCase();
      const optionValues = tagName === 'select' ? selectOptionValues(described.node) : undefined;
      // file input 的元数据要让调用方能分辨多个隐藏 input、判断是否改投（issue #4a）。
      const isFileInput = tagName === 'input' && semantic.inputType === 'file';
      const fileMeta = isFileInput ? await this.readFileInputState(nodeId, signal) : undefined;
      rows.push({
        elementKey: String(nodeId),
        frameId: 'main',
        localFingerprint: elementFingerprint(described.node, semantic),
        role: semantic.role,
        name: semantic.name,
        disabled: Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true',
        tagName,
        ...(semantic.clickSource ? { clickSource: semantic.clickSource } : {}),
        inputType: semantic.inputType,
        formAction: semantic.formAction,
        optionValues,
        checked: semantic.checked,
        ...(native.value === undefined ? {} : { value: native.value }),
        ...(native.valueTruncated === true ? { valueTruncated: true as const } : {}),
        ...(isFileInput
          ? {
              accept: attrs.accept ?? '',
              multiple: Object.hasOwn(attrs, 'multiple'),
              inputIndex: fileMeta?.inputIndex ?? -1,
              label: fileMeta?.label ?? '',
              visible: fileMeta?.visible ?? false,
            }
          : {}),
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
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: id, depth: 3 },
        signal,
      );
      const semantic = await this.semanticDetails(
        described.node,
        attributes(described.node.attributes ?? []),
        signal,
      );
      return elementFingerprint(described.node, semantic);
    } catch {
      return undefined;
    }
  }

  async applyEffect(
    frameId: string,
    elementKey: string,
    effect: BrowserEffect,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<void | UploadReceipt | ActionEffect> {
    const cancel = () => this.pointer.hideFor(this.view);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const outcome = await this.applyVisibleEffect(
        frameId,
        elementKey,
        effect,
        signal,
        expectedFingerprint,
      );
      this.pointer.settle();
      return outcome;
    } catch (error) {
      cancel();
      throwIfAborted(signal);
      if (
        !(error instanceof BrowserError) &&
        (await this.elementFingerprint(frameId, elementKey, signal)) === undefined
      )
        throw new BrowserError('STALE_ELEMENT', 'Target element is gone; observe again', true);
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  private async applyVisibleEffect(
    frameId: string,
    elementKey: string,
    effect: BrowserEffect,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<void | UploadReceipt | ActionEffect> {
    throwIfAborted(signal);
    if (frameId !== 'main')
      throw new BrowserError(
        'UNSUPPORTED_ELEMENT',
        'Only observed main-frame elements are supported',
      );
    // press 不带 ref：发给 document.activeElement，跳过具体节点定位（issue #3）。
    if (elementKey === ACTIVE_ELEMENT_KEY) {
      if (effect.kind !== 'press')
        throw new BrowserError(
          'UNSUPPORTED_ELEMENT',
          'Only press supports the active element target',
        );
      return this.pressActiveElement(effect, signal);
    }
    const id = nodeId(elementKey);
    const described = await this.command<{ node: CdpNode }>(
      'DOM.describeNode',
      { nodeId: id, depth: 3 },
      signal,
    );
    const attrs = attributes(described.node.attributes ?? []);
    // 校验批准时的身份，移动期间沿用这份基线，不能改用新的身份。
    if (
      expectedFingerprint !== undefined &&
      elementFingerprint(
        described.node,
        await this.semanticDetails(described.node, attrs, signal),
      ) !== expectedFingerprint
    )
      throw new BrowserError('STALE_ELEMENT', 'Element identity changed; observe again', true);
    const tagName = described.node.nodeName.toLowerCase();
    if (Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true') {
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'Effect target is disabled');
    }
    if (effect.kind === 'upload') {
      // 隐藏 input 没有 layout：不能走 moveToNode / getBoxModel，直接把路径交给 Chromium。
      if (tagName !== 'input' || attrs.type !== 'file')
        throw new BrowserError(
          'UNSUPPORTED_ELEMENT',
          'browser.upload_file requires an input[type=file] target',
        );
      return this.writeAndVerifyFileInput(id, effect.files, signal);
    }
    if (effect.kind === 'type') {
      await this.prepareControl(id, signal, expectedFingerprint);
      await this.focusControl(id, signal);
      if (effect.replace !== false) {
        await this.command(
          'Input.dispatchKeyEvent',
          {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers: 2,
            commands: ['selectAll'],
          },
          signal,
        );
        await this.command(
          'Input.dispatchKeyEvent',
          { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 },
          signal,
        );
      }
      if (effect.text === '') {
        // Empty insertText is a no-op in Chromium; Backspace deletes the selection.
        if (effect.replace !== false) await this.dispatchKey('Backspace', 0, signal);
      } else await this.command('Input.insertText', { text: effect.text }, signal);
      return;
    }
    if (effect.kind === 'press') {
      assertPressAllowed(effect);
      await this.prepareControl(id, signal, expectedFingerprint);
      await this.focusControl(id, signal);
      // 基线必须取在 focus 之后：focusControl 自己会把 activeElement 换成本元素，
      // 若在 focus 前读，任何 no-op 按键都会被误判为 activated（issue #3 的静默无效点击）。
      const before = await this.readPageState(signal);
      await this.dispatchKey(effect.key, effect.modifiers.includes('Shift') ? 8 : 0, signal);
      const after = await this.readPageState(signal);
      return pressEffect(before, after);
    }
    if (effect.kind === 'hover') {
      await this.hoverToReveal(id, signal);
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
      await this.prepareControl(id, signal, expectedFingerprint);
      await this.focusControl(id, signal).catch((error) => {
        if (!(error instanceof BrowserError) || error.code !== 'UNSUPPORTED_ELEMENT') throw error;
      });
      // Native popup keyboard behavior differs by OS. This fixed select-only operation
      // receives a validated value, never caller-provided JavaScript.
      const resolved = await this.resolveControl(id, signal);
      try {
        const result = await this.command<{
          result: { value?: string };
          exceptionDetails?: unknown;
        }>(
          'Runtime.callFunctionOn',
          {
            objectId: resolved.object.objectId,
            functionDeclaration: `function(value) {
            if (this.tagName !== 'SELECT' || this.disabled || !Array.from(this.options).some(option => option.value === value && !option.disabled)) throw new Error('Unavailable select option');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(this, value);
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').get.call(this);
          }`,
            arguments: [{ value: effect.value }],
            returnByValue: true,
          },
          signal,
        );
        if (result.exceptionDetails || result.result.value !== effect.value)
          throw new BrowserError(
            'UNSUPPORTED_ELEMENT',
            'The page did not accept the selected option',
          );
      } finally {
        await this.command('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(
          () => undefined,
        );
      }
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
    if (effect.kind === 'click') {
      try {
        await this.clickNode(id, signal, expectedFingerprint);
      } catch (error) {
        // hover-only 控件：先自动 hover 一次再重试，绝不无限重试（issue #3）。
        if (isNoLayout(error)) {
          await this.hoverToReveal(id, signal);
          try {
            await this.clickNode(id, signal, expectedFingerprint);
          } catch (retryError) {
            if (effect.force) return this.forceActivate(id, signal);
            throw retryError;
          }
        } else if (effect.force) {
          return this.forceActivate(id, signal);
        } else {
          throw error;
        }
      }
      return;
    }
    try {
      await this.clickNode(id, signal, expectedFingerprint);
    } catch (error) {
      if (
        effect.kind !== 'check' ||
        !(error instanceof BrowserError) ||
        error.code !== 'UNSUPPORTED_ELEMENT'
      )
        throw error;
      await this.prepareControl(id, signal, expectedFingerprint);
      const resolved = await this.resolveControl(id, signal);
      try {
        const result = await this.command<{
          result: { value?: boolean };
          exceptionDetails?: unknown;
        }>(
          'Runtime.callFunctionOn',
          {
            objectId: resolved.object.objectId,
            functionDeclaration: `function(checked) {
            if (this.tagName !== 'INPUT' || !['checkbox','radio'].includes(this.type) || this.disabled || this.getAttribute('aria-disabled') === 'true') throw new Error('Unavailable check control');
            if (this.checked !== checked) HTMLElement.prototype.click.call(this);
            return this.checked;
          }`,
            arguments: [{ value: effect.checked }],
            returnByValue: true,
          },
          signal,
        );
        if (result.exceptionDetails || result.result.value !== effect.checked)
          throw new BrowserError(
            'UNSUPPORTED_ELEMENT',
            'The page did not accept the checked state',
          );
      } finally {
        await this.command('Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(
          () => undefined,
        );
      }
    }
  }

  setLifecycleListener(listener: (event: PageLifecycleEvent) => void): void {
    this.listener = listener;
  }

  #recording: RecordingChannel | undefined;

  /** 一个页面一个通道：重复开始录制会撞上通道自己的守卫，而不是悄悄泄漏一个监听。 */
  #recordingChannel(): RecordingChannel {
    if (this.#recording) return this.#recording;
    const dbg = this.view.webContents.debugger;
    const listeners = new Map<
      CdpListener,
      (event: unknown, method: string, params: unknown) => void
    >();
    const cdp: CdpLike = {
      sendCommand: (method, params) => dbg.sendCommand(method, params),
      on: (listener) => {
        const wrapped = (_event: unknown, method: string, params: unknown) =>
          listener(method, (params ?? {}) as Record<string, unknown>);
        listeners.set(listener, wrapped);
        dbg.on('message', wrapped);
      },
      off: (listener) => {
        const wrapped = listeners.get(listener);
        if (wrapped) dbg.removeListener('message', wrapped);
        listeners.delete(listener);
      },
    };
    this.#recording = new RecordingChannel(cdp);
    return this.#recording;
  }

  async startRecording(options: RecordingChannelOptions): Promise<void> {
    await this.#recordingChannel().start(options);
  }

  async stopRecording(): Promise<void> {
    await this.#recording?.stop();
  }

  /**
   * 固定 CDP 开关：后台标签被唤醒时打开、回落时关闭。让页面自认为有键盘焦点，
   * 解决自绘编辑器（依赖 focus 事件的 contenteditable / CodeMirror / Monaco）在后台的输入稳定性。
   * 绝不调用 webContents.focus()——那会把整个应用/窗口拉到前台。
   */
  setFocusEmulation(enabled: boolean): void {
    const wc = this.view.webContents;
    if (wc.isDestroyed() || !wc.debugger.isAttached()) return;
    wc.debugger
      .sendCommand('Emulation.setFocusEmulationEnabled', { enabled })
      .catch(() => undefined);
  }

  close(): void {
    void this.stopRecording();
    if (this.closed) return;
    this.closed = true;
    this.pointer.hideFor(this.view);
    if (this.view.webContents.debugger.isAttached()) this.view.webContents.debugger.detach();
    try {
      this.parent.contentView.removeChildView(this.view);
    } catch {
      /* parent may already be closing */
    }
    this.view.webContents.close();
  }

  private guardNavigation(url: string, redirect: boolean): boolean {
    const key = navigationKey(url);
    if (this.allowedNavigations.delete(key)) return true;
    if (redirect && this.claimRedirect) {
      this.claimRedirect(url);
      return false;
    }
    // Preserve POST bodies, referrers and 307/308 semantics. Chromium owns
    // HTTP(S) request routing, including redirect hops.
    try {
      return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  }

  private async semanticDetails(
    node: CdpNode,
    attrs: Record<string, string>,
    signal?: AbortSignal,
    native?: NativeControlState,
  ): Promise<ElementSemantics> {
    const inferred = inferredRole(node.nodeName, attrs);
    const clickSource = inferred ? undefined : genericClickSource(node.nodeName, attrs);
    let role = attrs.role || inferred || (clickSource ? 'clickable' : '');
    let name = attrs['aria-label'] || attrs.alt || attrs.title || attrs.placeholder || '';
    let checked: boolean | undefined;
    let pressed: ElementSemantics['pressed'];
    let href: string | undefined;
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
      const pressedValue = ax.nodes?.[0]?.properties?.find(
        (property) => property.name === 'pressed',
      )?.value?.value;
      if (pressedValue === true || pressedValue === 'true') pressed = true;
      else if (pressedValue === false || pressedValue === 'false') pressed = false;
      else if (pressedValue === 'mixed') pressed = 'mixed';
      const urlValue = ax.nodes?.[0]?.properties?.find((property) => property.name === 'url')?.value
        ?.value;
      if (typeof urlValue === 'string') href = urlValue;
    } catch {
      /* AX may be unavailable during navigation. */
    }
    if (pressed === undefined) {
      if (attrs['aria-pressed'] === 'true') pressed = true;
      else if (attrs['aria-pressed'] === 'false') pressed = false;
      else if (attrs['aria-pressed'] === 'mixed') pressed = 'mixed';
    }
    const tagName = node.nodeName.toLowerCase();
    const inputType = tagName === 'input' ? (attrs.type || 'text').toLowerCase() : undefined;
    if (inputType === 'checkbox' || inputType === 'radio') {
      // AX can lag behind input.checked. Never use stale AX or the default checked
      // attribute to decide whether a native control needs a click.
      checked = (native ?? (await this.nativeControlState(node, attrs, signal))).checked;
    }
    const buttonType = tagName === 'button' ? attrs.type : undefined;
    if (tagName === 'a' || role === 'link') {
      // AX 的 URL 已解析 <base>；缺失时按页面地址解析属性。
      if (href === undefined && Object.hasOwn(attrs, 'href')) {
        try {
          href = new URL(attrs.href, this.view.webContents.getURL()).toString();
        } catch {
          href = attrs.href;
        }
      }
    } else href = undefined;
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
    const resolvedName = (name || (clickSource ? nearestText(node) : '')).trim().slice(0, 200);
    return {
      role,
      name: resolvedName,
      inputType,
      buttonType,
      href,
      formAction,
      checked,
      pressed,
      ...(clickSource ? { clickSource } : {}),
    };
  }

  private async nativeControlState(
    node: CdpNode,
    attrs: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<NativeControlState> {
    const tagName = node.nodeName.toLowerCase();
    if (
      !['input', 'textarea', 'select'].includes(tagName) ||
      (tagName === 'input' && (attrs.type || 'text').toLowerCase() === 'password')
    )
      return {};
    let objectId: string | undefined;
    try {
      const tree = await this.command<{ frameTree: { frame: { id: string } } }>(
        'Page.getFrameTree',
        {},
        signal,
      );
      const world = await this.command<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        {
          frameId: tree.frameTree.frame.id,
          worldName: 'pilion-native-control-state',
          grantUniveralAccess: false,
        },
        signal,
      );
      const resolved = await this.command<{ object: { objectId?: string } }>(
        'DOM.resolveNode',
        { nodeId: node.nodeId, executionContextId: world.executionContextId },
        signal,
      );
      objectId = resolved.object.objectId;
      if (!objectId) return {};
      const result = await this.command<{
        result: { value?: NativeControlState };
        exceptionDetails?: unknown;
      }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: READ_NATIVE_CONTROL_STATE,
          returnByValue: true,
        },
        signal,
      );
      if (result.exceptionDetails) return {};
      const state = result.result.value;
      return {
        ...(typeof state?.value === 'string' ? { value: state.value } : {}),
        ...(state?.valueTruncated === true ? { valueTruncated: true as const } : {}),
        ...(typeof state?.checked === 'boolean' ? { checked: state.checked } : {}),
      };
    } catch {
      throwIfAborted(signal);
      // Missing nodes/worlds during navigation do not yield inexact AX/default values.
      return {};
    } finally {
      if (objectId)
        await this.command('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
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

  private async resolveControl(
    id: number,
    signal?: AbortSignal,
  ): Promise<{ object: { objectId: string } }> {
    const tree = await this.command<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
      {},
      signal,
    );
    const world = await this.command<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      {
        frameId: tree.frameTree.frame.id,
        worldName: 'pilion-native-control-state',
        grantUniveralAccess: false,
      },
      signal,
    );
    return this.command(
      'DOM.resolveNode',
      { nodeId: id, executionContextId: world.executionContextId },
      signal,
    );
  }

  /** 读一次 file input 的后验状态；节点消失/上下文失效时返回 undefined，绝不抛出误报成功。 */
  private async readFileInputState(
    id: number,
    signal?: AbortSignal,
  ): Promise<ReadFileInputState | undefined> {
    let objectId: string | undefined;
    try {
      const resolved = await this.resolveControl(id, signal);
      objectId = resolved.object.objectId;
      const result = await this.command<{
        result: { value?: ReadFileInputState };
        exceptionDetails?: unknown;
      }>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: READ_FILE_INPUT_STATE, returnByValue: true },
        signal,
      );
      if (result.exceptionDetails) return undefined;
      return result.result.value;
    } catch {
      return undefined;
    } finally {
      if (objectId)
        await this.command('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  /**
   * issue #4a：setFileInputFiles 只保证「写进 input」，不保证页面消费。写入前记录 body 指纹，
   * 写入后回读文件数与页面指纹，把 applied / unconfirmed / rejected 如实回报，绝不谎报成功。
   */
  private async writeAndVerifyFileInput(
    id: number,
    files: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<UploadReceipt> {
    const before = await this.readFileInputState(id, signal);
    await this.command('DOM.setFileInputFiles', { nodeId: id, files: [...files] }, signal);
    const after = await this.readFileInputState(id, signal);
    const input = {
      accept: after?.accept ?? '',
      multiple: after?.multiple ?? false,
      index: after?.inputIndex ?? -1,
      label: after?.label ?? '',
      visible: after?.visible ?? false,
    };
    const base = { files: files.length, input, names: after?.names ?? [] };
    if (!after || after.disabled || !after.stillInDom || after.fileCount === 0)
      return {
        ...base,
        ok: false,
        appliedFiles: after?.fileCount ?? 0,
        verified: 'rejected',
        effect: 'none',
        warning: `页面拒绝了这批文件：${!after ? '无法回读 input 状态' : 'input 已禁用、已离开 DOM 或 files 为空'}。请用 observe 重新确认目标 input。`,
      };
    const pageChanged = before !== undefined && before.bodyFingerprint !== after.bodyFingerprint;
    if (pageChanged && after.fileCount === files.length)
      return { ...base, ok: true, appliedFiles: after.fileCount, verified: 'applied' };
    return {
      ...base,
      ok: false,
      appliedFiles: after.fileCount,
      verified: 'unconfirmed',
      effect: 'none',
      warning: `已写入 input（appliedFiles=${after.fileCount}），但页面未确认接收：DOM 未变化。ok 不代表页面已接收，必须用 read/observe 复核卡片数；若仍为 0，改投另一个 file input。`,
    };
  }

  private async focusControl(id: number, signal?: AbortSignal): Promise<void> {
    try {
      await this.command('DOM.focus', { nodeId: id }, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (
        error instanceof Error &&
        /cannot focus|could not focus|not focusable|layout object/i.test(error.message)
      )
        throw unsupportedBeforeInput('Target cannot receive keyboard focus');
      throw error;
    }
  }

  /** Pointer geometry is optional for keyboard and fixed native-control operations. */
  private async prepareControl(
    id: number,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<void> {
    try {
      await this.moveToNode(id, signal, expectedFingerprint);
    } catch (error) {
      if (!(error instanceof BrowserError) || error.code !== 'UNSUPPORTED_ELEMENT') throw error;
      // Never let a geometry fallback bypass identity, disabled-state or cancellation checks.
      const current = await this.elementFingerprint('main', String(id), signal);
      throwIfAborted(signal);
      if (!current || (expectedFingerprint !== undefined && current !== expectedFingerprint))
        throw new BrowserError('STALE_ELEMENT', 'Target changed; observe again', true);
      const { node } = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: id, depth: 0 },
        signal,
      );
      const attrs = attributes(node.attributes ?? []);
      if (Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true')
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'Effect target is disabled');
    }
  }

  private async nodePoint(id: number, signal?: AbortSignal): Promise<{ x: number; y: number }> {
    const box = await this.command<{ model: { content: number[] } }>(
      'DOM.getBoxModel',
      { nodeId: id },
      signal,
    );
    const q = box.model.content;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    const metrics = await this.command<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics', {}, signal);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= metrics.cssLayoutViewport.clientWidth ||
      y >= metrics.cssLayoutViewport.clientHeight
    )
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'Target is outside the visible page');
    return { x, y };
  }

  private async moveToNode(
    id: number,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<{ x: number; y: number }> {
    try {
      const before =
        expectedFingerprint ?? (await this.elementFingerprint('main', String(id), signal));
      if (!before)
        throw new BrowserError('STALE_ELEMENT', 'Target element is gone; observe again', true);
      await this.command('DOM.scrollIntoViewIfNeeded', { nodeId: id }, signal);
      let point = await this.nodePoint(id, signal);
      const zoom = this.view.webContents.getZoomFactor();
      // 只追踪同一个节点；初次移动后最多再跟随三次。
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        await this.pointer.move(
          this.view,
          { x: point.x * zoom, y: point.y * zoom },
          async ({ x, y }) => {
            await this.command(
              'Input.dispatchMouseEvent',
              { type: 'mouseMoved', x: x / zoom, y: y / zoom, button: 'none' },
              signal,
            );
          },
          signal,
        );
        await this.command('DOM.scrollIntoViewIfNeeded', { nodeId: id }, signal);
        const after = await this.elementFingerprint('main', String(id), signal);
        if (before !== after)
          throw new BrowserError(
            'STALE_ELEMENT',
            'Target changed during pointer movement; observe again',
            true,
          );
        const current = await this.nodePoint(id, signal);
        if (Math.abs(current.x - point.x) <= 1 && Math.abs(current.y - point.y) <= 1) break;
        if (attempt === 3)
          throw new BrowserError('STALE_ELEMENT', 'Target kept moving; observe again', true);
        point = current;
      }
      const viewport = await this.command<{ cssLayoutViewport: { pageX: number; pageY: number } }>(
        'Page.getLayoutMetrics',
        {},
        signal,
      );
      const hit = await this.command<{ nodeId?: number }>(
        'DOM.getNodeForLocation',
        {
          x: Math.round(point.x + viewport.cssLayoutViewport.pageX),
          y: Math.round(point.y + viewport.cssLayoutViewport.pageY),
          includeUserAgentShadowDOM: false,
        },
        signal,
      );
      if (!hit.nodeId) throw unsupportedBeforeInput('Target is not visible');
      const subtree = await this.command<{ nodeIds: number[] }>(
        'DOM.querySelectorAll',
        { nodeId: id, selector: '*' },
        signal,
      );
      if (hit.nodeId !== id && !subtree.nodeIds.includes(hit.nodeId))
        throw unsupportedBeforeInput(
          'Another element covers the target; use a keyboard or native-control operation',
        );
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: id, depth: 0 },
        signal,
      );
      const attrs = attributes(described.node.attributes ?? []);
      if (Object.hasOwn(attrs, 'disabled') || attrs['aria-disabled'] === 'true')
        throw new BrowserError('UNSUPPORTED_ELEMENT', 'Effect target is disabled');
      return point;
    } catch (error) {
      throwIfAborted(signal);
      if (
        !(error instanceof BrowserError) &&
        !(await this.elementFingerprint('main', String(id), signal))
      )
        throw new BrowserError('STALE_ELEMENT', 'Target element is gone; observe again', true);
      if (error instanceof Error && /does not have a layout object/i.test(error.message))
        throw unsupportedBeforeInput('Target has no layout for pointer input');
      throw error;
    }
  }

  private async clickNode(
    id: number,
    signal?: AbortSignal,
    expectedFingerprint?: string,
  ): Promise<void> {
    const { x, y } = await this.moveToNode(id, signal, expectedFingerprint);
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
    await this.pointer.click();
  }

  /** press 不带 ref：按键直接发给当前焦点元素，并如实回报是否激活（issue #3）。 */
  private async pressActiveElement(
    effect: Extract<BrowserEffect, { kind: 'press' }>,
    signal?: AbortSignal,
  ): Promise<ActionEffect> {
    assertPressAllowed(effect);
    const before = await this.readPageState(signal);
    await this.dispatchKey(effect.key, effect.modifiers.includes('Shift') ? 8 : 0, signal);
    const after = await this.readPageState(signal);
    return pressEffect(before, after);
  }

  /** 隔离世界里的固定脚本：读轻量页面状态指纹，绝不执行页面/调用方提供的脚本。 */
  private async readPageState(signal?: AbortSignal): Promise<PageState | null> {
    let objectId: string | undefined;
    try {
      const root = await this.command<{ root: CdpNode }>(
        'DOM.getDocument',
        { depth: 0, pierce: false },
        signal,
      );
      const resolved = await this.resolveControl(root.root.nodeId, signal);
      objectId = resolved.object.objectId;
      const result = await this.command<{
        result: { value?: PageState | null };
        exceptionDetails?: unknown;
      }>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: READ_PAGE_STATE, returnByValue: true },
        signal,
      );
      if (result.exceptionDetails) return null;
      return result.result.value ?? null;
    } catch {
      return null;
    } finally {
      if (objectId)
        await this.command('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  /**
   * 把指针移到目标（无布局时沿父链找可悬停祖先，再不济用视口中心）并停留，
   * 让 hover-only 子控件获得布局（issue #3）。只发 mouseMoved，不按下。
   */
  private async hoverToReveal(id: number, signal?: AbortSignal): Promise<void> {
    let point: { x: number; y: number } | undefined;
    let current = id;
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        point = await this.nodePoint(current, signal);
        break;
      } catch {
        /* 无布局：上溯找可悬停祖先 */
      }
      const described = await this.command<{ node: CdpNode }>(
        'DOM.describeNode',
        { nodeId: current, depth: 0 },
        signal,
      );
      if (!described.node.parentId) break;
      current = described.node.parentId;
    }
    if (!point) {
      const metrics = await this.command<{
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      }>('Page.getLayoutMetrics', {}, signal);
      point = {
        x: metrics.cssLayoutViewport.clientWidth / 2,
        y: metrics.cssLayoutViewport.clientHeight / 2,
      };
    }
    const zoom = this.view.webContents.getZoomFactor();
    await this.pointer.move(
      this.view,
      { x: point.x * zoom, y: point.y * zoom },
      async ({ x, y }) => {
        await this.command(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: x / zoom, y: y / zoom, button: 'none' },
          signal,
        );
      },
      signal,
    );
    this.pointer.settle();
  }

  /** force：复用 check 的原生 click 合成激活绕过覆盖/无布局；失败再 focus + Space 兜底（issue #3）。 */
  private async forceActivate(id: number, signal?: AbortSignal): Promise<ActionEffect> {
    await this.prepareControl(id, signal);
    let objectId: string | undefined;
    try {
      const resolved = await this.resolveControl(id, signal);
      objectId = resolved.object.objectId;
      const result = await this.command<{
        result: { value?: boolean };
        exceptionDetails?: unknown;
      }>(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: FORCE_CLICK, returnByValue: true },
        signal,
      );
      if (!result.exceptionDetails && result.result.value === true)
        return { ok: true, effect: 'activated', detectedBy: 'synthetic-click' };
    } catch {
      /* 合成 click 不可用：落到键盘兜底 */
    } finally {
      if (objectId)
        await this.command('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
    await this.focusControl(id, signal);
    await this.dispatchKey('Space', 0, signal);
    return { ok: true, effect: 'dispatched', detectedBy: 'focus+space' };
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
  readonly pointer: AgentPointer;
  constructor(
    private readonly window: BrowserWindow,
    private readonly onCreated: (page: ElectronPagePort) => void,
    private readonly validateUrl: (url: string) => Promise<string>,
    pointerAllowed?: () => boolean,
    /** 只有目标 view 是用户正在看的活动标签时才画指针；后台标签只派发 CDP mouseMoved。 */
    pointerOnForeground?: (view: WebContentsView) => boolean,
  ) {
    this.pointer = new AgentPointer(window, pointerAllowed, pointerOnForeground);
  }

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
    const page = new ElectronPagePort(view, this.window, this.validateUrl, this.pointer);
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
  allowNavigation: (url: string, redirect: boolean) => boolean,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!allowNavigation(url, false)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    // Subframe redirects stay inside Chromium; only main-frame redirects become page navigations.
    if (event.isMainFrame && !allowNavigation(url, true)) event.preventDefault();
  });
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

/** loadURL records the abort of the page it replaced as its own failure, even when the new page loaded. */
function abortedReplacedPage(error: unknown, replaced: string): boolean {
  const failure = error as { errno?: unknown; url?: unknown } | undefined;
  return (
    failure?.errno === -3 &&
    typeof failure.url === 'string' &&
    navigationKey(failure.url) === navigationKey(replaced)
  );
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
function elementFingerprint(node: CdpNode, semantic: ElementSemantics): string {
  const tagName = node.nodeName.toLowerCase();
  // 展示状态不代表身份；始终用原 nodeId 校验和操作，不重新寻找相似节点。
  return createHash('sha256')
    .update(
      JSON.stringify({
        tagName,
        ...semantic,
        optionValues: tagName === 'select' ? selectOptionValues(node) : undefined,
      }),
    )
    .digest('hex');
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Browser operation revoked');
}
/**
 * 只对「带明确可交互标记」的无语义元素开放 observe（issue #3），避免无关 div 淹没结果：
 * onclick 属性、data-click/data-clickable 委托标记、tabindex 可聚焦、或 inline cursor:pointer。
 * 原生交互标签、已有显式 role、contenteditable 宿主都不归这里管。
 */
function genericClickSource(nodeName: string, attrs: Record<string, string>): string | undefined {
  const tag = nodeName.toLowerCase();
  if (['a', 'button', 'input', 'textarea', 'select', 'option'].includes(tag)) return undefined;
  if (attrs.role) return undefined;
  if (Object.hasOwn(attrs, 'onclick')) return 'onclick';
  if (Object.hasOwn(attrs, 'data-click') || Object.hasOwn(attrs, 'data-clickable'))
    return 'delegate';
  if (Object.hasOwn(attrs, 'tabindex')) return 'tabindex';
  if (/cursor\s*:\s*pointer/i.test(attrs.style ?? '')) return 'cursor';
  return undefined;
}

/** 从 describeNode 的子树里取最近文本，作为无语义可点击元素的 name 兜底。 */
function nearestText(node: CdpNode): string {
  const parts: string[] = [];
  const visit = (current: CdpNode, depth: number): void => {
    if (depth > 4 || parts.join(' ').length > 200) return;
    if (typeof current.nodeValue === 'string' && current.nodeValue.trim())
      parts.push(current.nodeValue.trim());
    for (const child of current.children ?? []) visit(child, depth + 1);
  };
  for (const child of node.children ?? []) visit(child, 0);
  return parts.join(' ').slice(0, 200);
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
  // contenteditable（含自绘编辑器 CodeMirror/Monaco 挂的隐藏输入框）映射为 textbox，
  // 否则 observe 既选不到它、也无法把它当输入框派发键盘事件。
  const editable = attrs.contenteditable;
  if (editable !== undefined && editable !== 'false' && editable !== 'inherit') return 'textbox';
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

function keyDetails(key: (typeof PRESS_KEYS)[number]): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
} {
  const virtualCodes = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Backspace: 8,
    Delete: 46,
    Space: 32,
  };
  if (key === 'Space') return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 };
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
  return { key, code: codes[key], windowsVirtualKeyCode: virtualCodes[key] };
}

function assertPressAllowed(effect: Extract<BrowserEffect, { kind: 'press' }>): void {
  if (
    !PRESS_KEYS.includes(effect.key) ||
    !Array.isArray(effect.modifiers) ||
    effect.modifiers.length > 1 ||
    effect.modifiers.some((modifier) => modifier !== 'Shift')
  )
    throw new BrowserError(
      'KEY_NOT_ALLOWED',
      'Key or modifier is not in the browser.press allowlist',
    );
}

function unsupportedBeforeInput(message: string): BrowserError {
  return new BrowserError('UNSUPPORTED_ELEMENT', message, false, undefined, 'not_applied');
}
