import { EventEmitter } from 'node:events';
import { Window } from 'happy-dom';
import type { BrowserWindow, WebContentsView } from 'electron';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentPointer } from '../src/main/browser/agent-pointer';
import { BrowserService } from '../src/main/browser/browser-service';
import { ElectronPagePort } from '../src/main/browser/electron-page-adapter';
import type { BrowserEffect } from '../src/main/browser/types';

type Point = { x: number; y: number };
const nativeWindows: Window[] = [];
afterEach(async () => {
  await Promise.all(nativeWindows.splice(0).map((window) => window.happyDOM.close()));
});
type ScriptedNode = {
  nodeId: number;
  nodeName: string;
  attributes: Record<string, string>;
  name: string;
  role: string;
  checked?: boolean;
  axChecked?: boolean | 'true' | 'false' | 'mixed';
  axValue?: string;
  pressed?: boolean | 'mixed';
  url?: string;
  optionValues?: string[];
  optionLabels?: string[];
  markup?: string;
  value?: string;
};

class ScriptedContents extends EventEmitter {
  target: ScriptedNode = {
    nodeId: 7,
    nodeName: 'BUTTON',
    attributes: {},
    name: '取消',
    role: 'button',
  };
  point: Point = { x: 100, y: 100 };
  zoom = 1;
  pageOffset: Point = { x: 0, y: 0 };
  covered = false;
  hitDescendant = false;
  onMove: () => void = () => undefined;
  onAx: () => void = () => undefined;
  clicks: Array<{ nodeId: number } & Point> = [];
  mouseEvents: Array<{ type: string } & Point> = [];
  hitPoints: Point[] = [];
  keys: string[] = [];
  focused?: number;
  scrolls = 0;
  commands: string[] = [];
  text = '';
  observedNodes?: ScriptedNode[];
  queries: Array<{ nodeId: number; selector: string }> = [];
  describedNodeIds: number[] = [];
  nativeWindow = new Window();
  nativeReadContexts: unknown[] = [];
  onNativeRead: (element: object) => void = () => undefined;
  nativeReadFails = false;
  axUnavailable = false;
  private selectedAll = false;
  private down?: number;

  constructor() {
    super();
    nativeWindows.push(this.nativeWindow);
  }

  readonly debugger = {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      this.commands.push(method);
      const id = params.nodeId;
      const target = this.observedNodes?.find((node) => node.nodeId === id) ?? this.target;
      if (id !== undefined && id !== 1 && id !== target.nodeId)
        throw new Error('Could not find node with given id');
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: [{ role: { value: 'StaticText' }, name: { value: this.text } }] };
        case 'DOM.getDocument':
          return { root: { nodeId: 1, nodeName: '#document' } };
        case 'DOM.querySelectorAll':
          this.queries.push({ nodeId: Number(id), selector: String(params.selector) });
          return {
            nodeIds:
              params.selector === '*'
                ? [8]
                : (this.observedNodes ?? [this.target]).map((node) => node.nodeId),
          };
        case 'DOM.describeNode':
          this.describedNodeIds.push(Number(id));
          return {
            node: {
              nodeId: target.nodeId,
              nodeName: target.nodeName,
              attributes: Object.entries(target.attributes).flat(),
              children:
                Number(params.depth) > 0
                  ? target.optionValues?.map((value, index) => ({
                      nodeId: 20 + index,
                      nodeName: 'OPTION',
                      attributes: ['value', value],
                    }))
                  : undefined,
            },
          };
        case 'DOM.getOuterHTML':
          return {
            outerHTML: `<${this.target.nodeName} ${JSON.stringify(this.target.attributes)}>${this.target.markup ?? this.target.name}</${this.target.nodeName}>`,
          };
        case 'Accessibility.getPartialAXTree':
          this.onAx();
          if (this.axUnavailable) throw new Error('AX unavailable');
          return {
            nodes: [
              {
                role: { value: target.role },
                name: { value: target.name },
                value: { value: target.axValue },
                properties: ['checked', 'pressed', 'url'].flatMap((name) => {
                  const value =
                    name === 'checked'
                      ? (target.axChecked ?? target.checked)
                      : target[name as 'pressed' | 'url'];
                  return value === undefined ? [] : [{ name, value: { value } }];
                }),
              },
            ],
          };
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'cdp-main-frame' } } };
        case 'Page.createIsolatedWorld':
          expect(params.frameId).toBe('cdp-main-frame');
          expect(params.grantUniveralAccess).toBe(false);
          return { executionContextId: 11 };
        case 'DOM.scrollIntoViewIfNeeded':
          this.scrolls += 1;
          if (this.point.y >= 600) this.point.y = 400;
          return {};
        case 'DOM.getBoxModel': {
          const { x, y } = this.point;
          return {
            model: { content: [x - 10, y - 10, x + 10, y - 10, x + 10, y + 10, x - 10, y + 10] },
          };
        }
        case 'Page.getLayoutMetrics':
          return {
            cssLayoutViewport: {
              clientWidth: 800,
              clientHeight: 600,
              pageX: this.pageOffset.x,
              pageY: this.pageOffset.y,
            },
          };
        case 'DOM.getNodeForLocation': {
          const point = { x: Number(params.x), y: Number(params.y) };
          this.hitPoints.push(point);
          const onTarget =
            Math.abs(point.x - this.pageOffset.x - this.point.x) <= 10 &&
            Math.abs(point.y - this.pageOffset.y - this.point.y) <= 10;
          return {
            nodeId: this.covered || !onTarget ? 99 : this.hitDescendant ? 8 : this.target.nodeId,
          };
        }
        case 'Input.dispatchMouseEvent': {
          const event = { type: String(params.type), x: Number(params.x), y: Number(params.y) };
          this.mouseEvents.push(event);
          if (event.type === 'mouseMoved') this.onMove();
          else if (event.type === 'mousePressed') this.down = this.target.nodeId;
          else if (event.type === 'mouseReleased' && this.down === this.target.nodeId) {
            this.clicks.push({ nodeId: this.target.nodeId, x: event.x, y: event.y });
            if (this.target.attributes.type === 'checkbox')
              this.target.checked = !this.target.checked;
            else if (this.target.attributes.type === 'radio') this.target.checked = true;
            this.down = undefined;
          }
          return {};
        }
        case 'DOM.focus':
          this.focused = Number(id);
          return {};
        case 'Input.insertText':
          // Chromium insertText('') does not delete the current selection.
          if (params.text !== '') {
            this.target.value =
              (this.selectedAll ? '' : (this.target.value ?? '')) + String(params.text);
            this.selectedAll = false;
          }
          return {};
        case 'Input.dispatchKeyEvent':
          if (params.type === 'keyDown') {
            this.keys.push(String(params.key));
            if (
              params.key === 'a' &&
              params.type === 'keyDown' &&
              Array.isArray(params.commands) &&
              params.commands.includes('selectAll')
            )
              this.selectedAll = true;
            if (params.key === 'Backspace' && this.selectedAll) {
              this.target.value = '';
              this.selectedAll = false;
            }
          }
          return {};
        case 'DOM.resolveNode':
          if (params.executionContextId !== undefined)
            this.nativeReadContexts.push(params.executionContextId);
          return { object: { objectId: String(id), type: 'object' } };
        case 'Runtime.callFunctionOn': {
          if (params.arguments) {
            const value = (params.arguments as Array<{ value: string }>)[0].value;
            this.target.value = value;
            return { result: { value } };
          }
          if (this.nativeReadFails)
            return { result: {}, exceptionDetails: { text: 'Unavailable' } };
          const current =
            this.observedNodes?.find((node) => String(node.nodeId) === params.objectId) ??
            this.target;
          const element = this.nativeWindow.document.createElement(current.nodeName);
          for (const [name, value] of Object.entries(current.attributes))
            element.setAttribute(name, value);
          if (element instanceof this.nativeWindow.HTMLSelectElement) {
            for (const [index, value] of (current.optionValues ?? []).entries()) {
              const option = this.nativeWindow.document.createElement('option');
              option.value = value;
              option.textContent = current.optionLabels?.[index] ?? value;
              element.append(option);
            }
          }
          if (
            element instanceof this.nativeWindow.HTMLInputElement ||
            element instanceof this.nativeWindow.HTMLTextAreaElement ||
            element instanceof this.nativeWindow.HTMLSelectElement
          )
            element.value = current.value ?? '';
          if (element instanceof this.nativeWindow.HTMLInputElement)
            element.checked = current.checked ?? false;
          this.onNativeRead(element);
          const read = this.nativeWindow.eval(`(${String(params.functionDeclaration)})`);
          return { result: { type: 'object', value: read.call(element) } };
        }
        case 'Runtime.releaseObject':
          return {};
        default:
          throw new Error(`Unexpected CDP command: ${method}`);
      }
    },
  };

  setWindowOpenHandler(): void {}
  getURL(): string {
    return 'https://x.com/home';
  }
  getZoomFactor(): number {
    return this.zoom;
  }
}

async function setup(configure: (contents: ScriptedContents) => void = () => undefined) {
  const contents = new ScriptedContents();
  configure(contents);
  const pointer = {
    move: async (
      _view: WebContentsView,
      point: Point,
      dispatch: (point: Point) => Promise<void>,
    ) => {
      await dispatch(point);
    },
    click: async () => undefined,
    settle: () => undefined,
    hideFor: () => undefined,
  } as unknown as AgentPointer;
  const port = new ElectronPagePort(
    { webContents: contents } as unknown as WebContentsView,
    {} as BrowserWindow,
    async (url) => url,
    pointer,
  );
  const service = new BrowserService({
    pageFactory: { create: async () => port },
    grantVerifier: { verify: async () => ({ grantId: 'approved', expiresAt: 10_000 }) },
    now: () => 1_000,
  });
  service.registry.add('tab', port, 'owner');
  const observation = await service.observe({ principalId: 'owner', tabId: 'tab' });
  const ref = observation.elements[0].ref;
  const prepare = (effect: BrowserEffect = { kind: 'click' }) =>
    service.prepareEffect({
      principalId: 'owner',
      tabId: 'tab',
      elementRef: ref,
      effect,
      grant: 'approved',
    });
  const execute = (executionToken: string) =>
    service.executePrepared({ principalId: 'owner', executionToken });
  const act = async (effect?: BrowserEffect) => execute((await prepare(effect)).executionToken);
  return { contents, port, service, ref, prepare, execute, act };
}

const stale = { code: 'STALE_ELEMENT', retryable: true };

function repositoryPage(contents: ScriptedContents) {
  contents.observedNodes = Array.from({ length: 405 }, (_, index) => ({
    nodeId: 2000 - index,
    nodeName: 'A',
    attributes: { href: `/item/${index}` },
    name: `Item ${index}`,
    role: 'link',
  }));
  contents.target = contents.observedNodes[237];
  contents.target.name = 'README.md';
  contents.target.attributes.href = '/citrolabs/ego-lite/blob/main/README.md';
  contents.target.url = 'https://github.com/citrolabs/ego-lite/blob/main/README.md';
}

describe('ElectronPagePort bounded page text', () => {
  it.each([59_999, 60_000, 60_001])(
    'reports truncation only beyond the text cap at %s',
    async (length) => {
      const f = await setup((contents) => {
        contents.text = '文'.repeat(length);
      });
      const snapshot = await f.port.readTextSnapshot();
      expect(snapshot).toEqual({
        text: '文'.repeat(Math.min(length, 60_000)),
        ...(length > 60_000 ? { textTruncated: true } : {}),
      });
      expect(await f.port.readText()).toBe(snapshot.text);
    },
  );
});

describe('ElectronPagePort observe pagination', () => {
  it('returns successive bounded pages in query order and an empty final page', async () => {
    const f = await setup(repositoryPage);
    f.contents.commands = [];
    f.contents.queries = [];
    f.contents.describedNodeIds = [];

    const first = await f.port.observeElements();
    const second = await f.port.observeElements(undefined, 200);
    const third = await f.port.observeElements(undefined, 400);
    const end = await f.port.observeElements(undefined, 405);

    expect([first.length, second.length, third.length, end.length]).toEqual([200, 200, 5, 0]);
    expect([first[0].elementKey, first[199].elementKey]).toEqual(['2000', '1801']);
    expect([second[0].elementKey, second[199].elementKey]).toEqual(['1800', '1601']);
    expect(third.map((row) => row.elementKey)).toEqual(['1600', '1599', '1598', '1597', '1596']);
    expect(first.some((row) => row.name === 'README.md')).toBe(false);
    expect(second[37]).toMatchObject({
      elementKey: '1763',
      frameId: 'main',
      role: 'link',
      name: 'README.md',
      tagName: 'a',
    });
    expect(f.contents.describedNodeIds).toHaveLength(405);
    expect(new Set(f.contents.describedNodeIds).size).toBe(405);
    expect(f.contents.queries).toEqual(
      Array.from({ length: 4 }, () => ({
        nodeId: 1,
        selector: 'a,button,input,textarea,select,[role],[contenteditable]',
      })),
    );
    expect(new Set(f.contents.commands)).toEqual(
      new Set([
        'DOM.getDocument',
        'DOM.querySelectorAll',
        'DOM.describeNode',
        'Accessibility.getPartialAXTree',
      ]),
    );
  });

  it.each([
    { offset: 1, first: '1999', last: '1800' },
    { offset: 199, first: '1801', last: '1602' },
    { offset: 201, first: '1799', last: '1600' },
  ])(
    'starts at element offset $offset without rounding to a page boundary',
    async ({ offset, first, last }) => {
      const f = await setup(repositoryPage);
      f.contents.describedNodeIds = [];

      const rows = await f.port.observeElements(undefined, offset);

      expect(rows).toHaveLength(200);
      expect([rows[0].elementKey, rows[199].elementKey]).toEqual([first, last]);
      expect(f.contents.describedNodeIds).toHaveLength(200);
    },
  );

  it('issues usable trusted refs for a later page and preserves earlier refs', async () => {
    const f = await setup(repositoryPage);
    const first = await f.service.observe({ principalId: 'owner', tabId: 'tab' });
    const later = await f.service.observe({ principalId: 'owner', tabId: 'tab', offset: 200 });
    const readme = later.elements.find((row) => row.name === 'README.md');

    expect(readme).toMatchObject({ role: 'link', tagName: 'a', disabled: false });
    expect(readme).not.toHaveProperty('elementKey');
    expect(Object.isFrozen(readme!.ref)).toBe(true);
    expect(readme!.ref.localFingerprint).toBe(await f.port.elementFingerprint('main', '1763'));
    await expect(
      f.service.describeElement('owner', 'tab', first.elements[0].ref),
    ).resolves.toMatchObject({ role: 'link', name: 'Item 0' });
    await expect(f.service.describeElement('owner', 'tab', readme!.ref)).resolves.toMatchObject({
      role: 'link',
      name: 'README.md',
    });

    const prepared = await f.service.prepareEffect({
      principalId: 'owner',
      tabId: 'tab',
      elementRef: readme!.ref,
      effect: { kind: 'click' },
      grant: 'approved',
    });
    await f.execute(prepared.executionToken);
    expect(f.contents.clicks).toEqual([{ nodeId: 1763, x: 100, y: 100 }]);

    await expect(
      f.service.describeElement('owner', 'tab', {
        ...readme!.ref,
        localFingerprint: 'forged',
      }),
    ).rejects.toMatchObject(stale);
    f.contents.target.url = 'https://github.com/citrolabs/ego-lite/delete';
    await expect(f.service.describeElement('owner', 'tab', readme!.ref)).rejects.toMatchObject(
      stale,
    );
  });

  it('rejects a revoked later-page observe before issuing refs', async () => {
    const f = await setup(repositoryPage);
    f.contents.onAx = () => f.service.invalidatePrincipal('owner');

    await expect(
      f.service.observe({ principalId: 'owner', tabId: 'tab', offset: 200 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ElectronPagePort native current state', () => {
  it.each(['INPUT', 'TEXTAREA', 'SELECT'])(
    'observes mutable %s values without treating them as identity',
    async (nodeName) => {
      const f = await setup((c) => {
        c.target.nodeName = nodeName;
        c.target.role = nodeName === 'SELECT' ? 'combobox' : 'textbox';
        c.target.attributes.value = 'markup-default';
        c.target.optionValues = ['one', 'two'];
        c.target.value = 'one';
        c.target.axValue = 'stale AX label';
      });
      const first = await f.service.observe({ principalId: 'owner', tabId: 'tab' });
      expect(first.elements[0]).toMatchObject({ value: 'one' });
      f.contents.target.value = 'two';
      const second = await f.service.observe({ principalId: 'owner', tabId: 'tab' });
      expect(second.elements[0]).toMatchObject({ value: 'two' });
      expect(second.elements[0].ref.localFingerprint).toBe(first.elements[0].ref.localFingerprint);
      await expect(
        f.service.describeElement('owner', 'tab', first.elements[0].ref),
      ).resolves.toMatchObject({ value: 'one' });
      expect(f.contents.nativeReadContexts.every((id) => id === 11)).toBe(true);
      expect(f.contents.clicks).toEqual([]);
      expect(f.contents.keys).toEqual([]);
    },
  );

  it('preserves literal multiline textarea whitespace and trailing newline', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.role = 'textbox';
      c.target.value = '  first\nsecond\n';
      c.target.axValue = 'first second';
    });
    const [row] = await f.port.observeElements();
    expect(row).toMatchObject({ value: '  first\nsecond\n' });
    expect(row).not.toHaveProperty('valueTruncated');
  });

  it('reads the select option value rather than its accessible label', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'SELECT';
      c.target.role = 'combobox';
      c.target.optionValues = ['dev', 'prod'];
      c.target.optionLabels = ['Development', 'Production'];
      c.target.value = 'prod';
      c.target.axValue = 'Production';
    });
    expect((await f.port.observeElements())[0]).toMatchObject({ value: 'prod' });
  });

  it('observes an empty current value as an empty string', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.role = 'textbox';
      c.target.value = '';
      c.target.attributes.value = 'default';
    });
    expect((await f.port.observeElements())[0]).toMatchObject({ value: '' });
  });

  it.each(['password', 'PASSWORD'])(
    'omits %s values without resolving them for native readback',
    async (type) => {
      const f = await setup((c) => {
        c.target.nodeName = 'INPUT';
        c.target.attributes.type = type;
        c.target.value = 'secret';
        c.target.axValue = 'secret';
      });
      f.contents.commands = [];
      const [row] = await f.port.observeElements();
      expect(row).not.toHaveProperty('value');
      expect(row).not.toHaveProperty('valueTruncated');
      expect(f.contents.commands).not.toContain('DOM.resolveNode');
    },
  );

  it('rechecks password type before reading a node that changed after description', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.value = 'secret';
    });
    f.contents.onNativeRead = (element) => {
      (element as { type: string }).type = 'password';
    };
    const [row] = await f.port.observeElements();
    expect(row).not.toHaveProperty('value');
  });

  it('reads native properties without invoking page-defined instance getters', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.value = 'exact\n';
    });
    f.contents.onNativeRead = (element) =>
      Object.defineProperty(element, 'value', {
        get: () => {
          throw new Error('Page-defined getter must not run');
        },
      });
    expect((await f.port.observeElements())[0]).toMatchObject({ value: 'exact\n' });
  });

  it.each([
    { length: 99_999, truncated: false },
    { length: 100_000, truncated: false },
    { length: 100_001, truncated: true },
  ])(
    'caps native readback at 100000 characters for length $length',
    async ({ length, truncated }) => {
      const f = await setup((c) => {
        c.target.nodeName = 'TEXTAREA';
        c.target.value = 'x'.repeat(length);
      });
      const [row] = await f.port.observeElements();
      expect(row).toMatchObject({ value: 'x'.repeat(Math.min(length, 100_000)) });
      if (truncated) expect(row).toHaveProperty('valueTruncated', true);
      else expect(row).not.toHaveProperty('valueTruncated');
      expect(f.contents.target.value).toHaveLength(length);
    },
  );

  it('omits unavailable native values instead of falling back to AX or markup', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.value = 'current\n';
      c.target.axValue = 'inexact';
      c.target.attributes.value = 'default';
    });
    f.contents.nativeReadFails = true;
    f.contents.commands = [];
    const [row] = await f.port.observeElements();
    expect(row).not.toHaveProperty('value');
    expect(row).not.toHaveProperty('valueTruncated');
    expect(f.contents.commands).toContain('Runtime.releaseObject');
  });

  it('still reads native values when AX is unavailable', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.value = 'current\n';
      c.axUnavailable = true;
    });
    expect((await f.port.observeElements())[0]).toMatchObject({ value: 'current\n' });
  });

  it('does not expose values for non-native editable elements', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'DIV';
      c.target.attributes.contenteditable = 'true';
      c.target.value = 'custom';
      c.target.axValue = 'custom';
    });
    const [row] = await f.port.observeElements();
    expect(row).not.toHaveProperty('value');
  });

  it('rejects observation revoked during native readback and releases the object', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.value = 'current';
    });
    f.contents.onNativeRead = () => f.service.invalidatePrincipal('owner');
    await expect(f.service.observe({ principalId: 'owner', tabId: 'tab' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.contents.commands.at(-1)).toBe('Runtime.releaseObject');
  });

  it.each(['checkbox', 'radio'])(
    'observes live %s checked state despite stale AX and checked attributes',
    async (type) => {
      const f = await setup((c) => {
        c.target.nodeName = 'INPUT';
        c.target.attributes = { type, checked: '' };
        c.target.checked = false;
        c.target.axChecked = true;
      });
      const [first] = await f.port.observeElements();
      expect(first.checked).toBe(false);
      f.contents.target.checked = true;
      const [second] = await f.port.observeElements();
      expect(second.checked).toBe(true);
      expect(second.localFingerprint).not.toBe(first.localFingerprint);
      await expect(f.act()).rejects.toMatchObject(stale);
    },
  );

  it('unchecks a native checkbox even when AX incorrectly reports it already off', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.attributes.type = 'checkbox';
      c.target.checked = true;
      c.target.axChecked = false;
    });
    await f.act({ kind: 'check', checked: false });
    expect(f.contents.target.checked).toBe(false);
    expect(f.contents.clicks).toHaveLength(1);
    expect((await f.port.observeElements())[0].checked).toBe(false);
  });

  it('does not toggle a checkbox already off even if AX claims it is on', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.attributes.type = 'checkbox';
      c.target.checked = false;
      c.target.axChecked = true;
    });
    await f.act({ kind: 'check', checked: false });
    expect(f.contents.target.checked).toBe(false);
    expect(f.contents.clicks).toEqual([]);
  });

  it('fails closed for native checked state when the getter is unavailable', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.attributes.type = 'checkbox';
      c.target.checked = true;
      c.target.axChecked = false;
      c.nativeReadFails = true;
    });
    expect((await f.port.observeElements())[0].checked).toBeUndefined();
    await expect(f.act({ kind: 'check', checked: false })).rejects.toMatchObject({
      code: 'UNSUPPORTED_ELEMENT',
    });
    expect(f.contents.clicks).toEqual([]);
  });

  it('preserves AX checked semantics for custom controls', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'DIV';
      c.target.role = 'checkbox';
      c.target.axChecked = 'true';
    });
    expect((await f.port.observeElements())[0].checked).toBe(true);
  });
});

describe('ElectronPagePort empty replacement', () => {
  it('replaces existing multiline text with a native selectAll command', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'TEXTAREA';
      c.target.role = 'textbox';
      c.target.value = 'old first\nold second\n';
    });
    await f.act({ kind: 'type', text: 'new\n' });
    expect(f.contents.target.value).toBe('new\n');
  });

  it.each(['INPUT', 'TEXTAREA'])('clears selected %s text with Backspace', async (nodeName) => {
    const f = await setup((c) => {
      c.target.nodeName = nodeName;
      c.target.role = 'textbox';
      c.target.value = 'existing text';
    });
    await f.act({ kind: 'type', text: '' });
    expect(f.contents.target.value).toBe('');
    expect(f.contents.keys).toEqual(['a', 'Backspace']);
    expect(f.contents.commands).not.toContain('Input.insertText');
    expect((await f.port.observeElements())[0]).toMatchObject({ value: '' });
  });

  it('leaves text intact for an empty append', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'INPUT';
      c.target.value = 'keep';
    });
    await f.act({ kind: 'type', text: '', replace: false });
    expect(f.contents.target.value).toBe('keep');
    expect(f.contents.keys).toEqual([]);
  });
});

describe('ElectronPagePort semantic identity', () => {
  it('clicks through hover-induced class changes using the observed ref', async () => {
    const f = await setup();
    f.contents.onMove = () => {
      f.contents.target.attributes.class = 'hovered';
    };
    await f.act();
    await f.act();
    expect(f.contents.clicks).toEqual([
      { nodeId: 7, x: 100, y: 100 },
      { nodeId: 7, x: 100, y: 100 },
    ]);
  });

  it('clicks a button enabled after observation', async () => {
    const f = await setup((c) => {
      c.target.attributes.disabled = '';
    });
    delete f.contents.target.attributes.disabled;
    await f.act();
    expect(f.contents.clicks).toEqual([{ nodeId: 7, x: 100, y: 100 }]);
  });

  it('ignores presentation attributes and descendant markup with the same accessible name', async () => {
    const f = await setup();
    Object.assign(f.contents.target.attributes, {
      class: 'new',
      style: 'color:red',
      'aria-disabled': 'false',
      'aria-expanded': 'true',
      'aria-selected': 'true',
      'data-counter': '2',
    });
    f.contents.target.markup = '<span class="counter">2</span>';
    await f.act();
    expect(f.contents.clicks).toHaveLength(1);
  });

  it('uses resolved link URLs rather than href spelling', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'A';
      c.target.role = 'link';
      c.target.attributes.href = '/post/1';
      c.target.url = 'https://x.com/post/1';
    });
    f.contents.target.attributes.href = 'https://x.com/post/1';
    await f.act();
    expect(f.contents.clicks).toHaveLength(1);
  });

  it('rejects a target that is still disabled at execution', async () => {
    const f = await setup((c) => {
      c.target.attributes.disabled = '';
    });
    await expect(f.act()).rejects.toMatchObject({ code: 'UNSUPPORTED_ELEMENT' });
    expect(f.contents.clicks).toEqual([]);
  });

  it('rejects a target disabled after approval', async () => {
    const f = await setup();
    const prepared = await f.prepare();
    f.contents.target.attributes['aria-disabled'] = 'true';
    await expect(f.execute(prepared.executionToken)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ELEMENT',
    });
    expect(f.contents.clicks).toEqual([]);
  });

  for (const effect of [
    { kind: 'click' },
    { kind: 'type', text: '不能输入', replace: false },
    { kind: 'press', key: 'Enter', modifiers: [] },
    { kind: 'select', value: 'two' },
  ] satisfies BrowserEffect[]) {
    it(`rejects ${effect.kind} when the target becomes disabled during pointer movement`, async () => {
      const f = await setup((c) => {
        if (effect.kind === 'select') {
          c.target.nodeName = 'SELECT';
          c.target.role = 'combobox';
          c.target.optionValues = ['one', 'two'];
        } else if (effect.kind !== 'click') {
          c.target.nodeName = 'INPUT';
          c.target.role = 'textbox';
        }
      });
      f.contents.onMove = () => {
        f.contents.target.attributes['aria-disabled'] = 'true';
      };
      await expect(f.act(effect)).rejects.toMatchObject({ code: 'UNSUPPORTED_ELEMENT' });
      expect(f.contents.mouseEvents.filter((event) => event.type === 'mousePressed')).toEqual([]);
      expect(f.contents.focused).toBeUndefined();
      expect(f.contents.target.value).toBeUndefined();
      expect(f.contents.keys).toEqual([]);
      expect(f.contents.clicks).toEqual([]);
    });
  }

  for (const effect of [
    { kind: 'click' },
    { kind: 'type', text: '不能输入', replace: false },
    { kind: 'press', key: 'Enter', modifiers: [] },
    { kind: 'select', value: 'two' },
  ] satisfies BrowserEffect[]) {
    it(`rejects a changed approved identity before the adapter captures its ${effect.kind} baseline`, async () => {
      const f = await setup((c) => {
        if (effect.kind === 'select') {
          c.target.nodeName = 'SELECT';
          c.target.role = 'combobox';
          c.target.optionValues = ['one', 'two'];
        } else if (effect.kind !== 'click') {
          c.target.nodeName = 'INPUT';
          c.target.role = 'textbox';
        }
      });
      const applyEffect = f.port.applyEffect.bind(f.port);
      f.port.applyEffect = (...args) => {
        f.contents.target.name = '删除';
        return applyEffect(...args);
      };
      await expect(f.act(effect)).rejects.toMatchObject(stale);
      expect(f.contents.mouseEvents).toEqual([]);
      expect(f.contents.focused).toBeUndefined();
      expect(f.contents.target.value).toBeUndefined();
      expect(f.contents.keys).toEqual([]);
    });
  }

  it('rejects node replacement after service validation but before adapter dispatch', async () => {
    const f = await setup();
    const applyEffect = f.port.applyEffect.bind(f.port);
    f.port.applyEffect = (...args) => {
      f.contents.target = { ...f.contents.target, nodeId: 9 };
      return applyEffect(...args);
    };
    await expect(f.act()).rejects.toMatchObject(stale);
    expect(f.contents.mouseEvents).toEqual([]);
  });

  it('keeps an invalid link URL observable without accepting identity changes', async () => {
    const f = await setup((c) => {
      c.target.nodeName = 'A';
      c.target.attributes.href = 'http://[';
    });
    await f.act();
    expect(f.contents.clicks).toHaveLength(1);
    f.contents.target.attributes.href = '/delete';
    await expect(f.act()).rejects.toMatchObject(stale);
  });

  for (const effect of [
    { kind: 'type', text: '你好', replace: false },
    { kind: 'press', key: 'Enter', modifiers: [] },
    { kind: 'select', value: 'two' },
  ] satisfies BrowserEffect[]) {
    it(`applies ${effect.kind} through hover-induced presentation changes`, async () => {
      const f = await setup((c) => {
        c.target.nodeName = effect.kind === 'select' ? 'SELECT' : 'INPUT';
        c.target.role = effect.kind === 'select' ? 'combobox' : 'textbox';
        c.target.optionValues = ['one', 'two'];
      });
      f.contents.onMove = () => {
        f.contents.target.attributes.class = 'hovered';
      };
      await f.act(effect);
      expect(f.contents.focused).toBe(7);
      if (effect.kind === 'type') expect(f.contents.target.value).toBe('你好');
      else if (effect.kind === 'press') expect(f.contents.keys).toEqual(['Enter']);
      else expect(f.contents.target.value).toBe('two');
      expect(f.contents.clicks).toEqual([]);
    });
  }

  const changes: Array<{
    name: string;
    configure?: (c: ScriptedContents) => void;
    mutate: (c: ScriptedContents) => void;
  }> = [
    {
      name: 'accessible name',
      mutate: (c) => {
        c.target.name = '删除';
      },
    },
    {
      name: 'role',
      configure: (c) => {
        c.target.nodeName = 'DIV';
      },
      mutate: (c) => {
        c.target.role = 'link';
      },
    },
    {
      name: 'tag',
      mutate: (c) => {
        c.target.nodeName = 'DIV';
      },
    },
    {
      name: 'link href',
      configure: (c) => {
        c.target.nodeName = 'A';
        c.target.attributes.href = '/post/1';
      },
      mutate: (c) => {
        c.target.attributes.href = '/post/2';
      },
    },
    {
      name: 'resolved link destination',
      configure: (c) => {
        c.target.nodeName = 'A';
        c.target.attributes.href = 'post';
        c.target.url = 'https://x.com/first/post';
      },
      mutate: (c) => {
        c.target.url = 'https://x.com/second/post';
      },
    },
    {
      name: 'checked state',
      configure: (c) => {
        c.target.nodeName = 'INPUT';
        c.target.attributes.type = 'checkbox';
        c.target.checked = false;
      },
      mutate: (c) => {
        c.target.checked = true;
      },
    },
    {
      name: 'AX pressed state',
      configure: (c) => {
        c.target.pressed = false;
      },
      mutate: (c) => {
        c.target.pressed = true;
      },
    },
    {
      name: 'aria-pressed state',
      configure: (c) => {
        c.target.attributes['aria-pressed'] = 'false';
      },
      mutate: (c) => {
        c.target.attributes['aria-pressed'] = 'true';
      },
    },
    {
      name: 'mixed pressed state',
      configure: (c) => {
        c.target.pressed = false;
      },
      mutate: (c) => {
        c.target.pressed = 'mixed';
      },
    },
    {
      name: 'input type',
      configure: (c) => {
        c.target.nodeName = 'INPUT';
        c.target.attributes.type = 'text';
      },
      mutate: (c) => {
        c.target.attributes.type = 'password';
      },
    },
    {
      name: 'button type',
      configure: (c) => {
        c.target.attributes.type = 'button';
      },
      mutate: (c) => {
        c.target.attributes.type = 'submit';
      },
    },
    {
      name: 'form action',
      configure: (c) => {
        c.target.attributes.formaction = '/safe';
      },
      mutate: (c) => {
        c.target.attributes.formaction = '/delete';
      },
    },
    {
      name: 'select options',
      configure: (c) => {
        c.target.nodeName = 'SELECT';
        c.target.optionValues = ['one', 'two'];
      },
      mutate: (c) => {
        c.target.optionValues = ['one', 'delete'];
      },
    },
    {
      name: 'replacement node with identical semantics',
      mutate: (c) => {
        c.target = { ...c.target, nodeId: 9 };
      },
    },
  ];

  for (const phase of [
    'before preparation',
    'after approval',
    'during pointer movement',
  ] as const) {
    for (const change of changes) {
      it(`rejects changed ${change.name} ${phase}`, async () => {
        const f = await setup(change.configure);
        if (phase === 'before preparation') {
          change.mutate(f.contents);
          await expect(f.act()).rejects.toMatchObject(stale);
        } else {
          const prepared = await f.prepare();
          if (phase === 'after approval') change.mutate(f.contents);
          else f.contents.onMove = () => change.mutate(f.contents);
          await expect(f.execute(prepared.executionToken)).rejects.toMatchObject(stale);
        }
        expect(f.contents.clicks).toEqual([]);
        expect(f.contents.mouseEvents.filter((event) => event.type === 'mousePressed')).toEqual([]);
      });
    }
  }

  it('rejects another element covering the click point', async () => {
    const f = await setup();
    f.contents.onMove = () => {
      f.contents.covered = true;
    };
    await expect(f.act()).rejects.toMatchObject(stale);
    expect(f.contents.clicks).toEqual([]);
  });

  it('allows a descendant at the click point', async () => {
    const f = await setup((c) => {
      c.hitDescendant = true;
    });
    await f.act();
    expect(f.contents.clicks).toHaveLength(1);
  });
});

describe('ElectronPagePort follows the observed moving node', () => {
  it('follows a target that moves once and hit-tests, presses and releases at its final point', async () => {
    const f = await setup((c) => {
      c.zoom = 1.25;
      c.pageOffset = { x: 50, y: 900 };
    });
    let moved = false;
    f.contents.onMove = () => {
      if (!moved) {
        moved = true;
        f.contents.point.y += 40;
      }
    };
    await f.act();
    expect(f.contents.hitPoints).toEqual([{ x: 150, y: 1040 }]);
    expect(f.contents.mouseEvents).toEqual([
      { type: 'mouseMoved', x: 100, y: 100 },
      { type: 'mouseMoved', x: 100, y: 140 },
      { type: 'mousePressed', x: 100, y: 140 },
      { type: 'mouseReleased', x: 100, y: 140 },
    ]);
    expect(f.contents.clicks).toEqual([{ nodeId: 7, x: 100, y: 140 }]);
  });

  it('follows a target that moves during post-animation semantic validation', async () => {
    const f = await setup();
    let moved = false;
    f.contents.onAx = () => {
      if (!moved && f.contents.mouseEvents.length > 0) {
        moved = true;
        f.contents.point.y += 40;
      }
    };
    await f.act();
    expect(f.contents.hitPoints).toEqual([{ x: 100, y: 140 }]);
    expect(f.contents.clicks).toEqual([{ nodeId: 7, x: 100, y: 140 }]);
  });

  it('allows three follow-up moves when the same node eventually settles', async () => {
    const f = await setup();
    let moves = 0;
    f.contents.onMove = () => {
      if (moves++ < 3) f.contents.point.y += 40;
    };
    await f.act();
    expect(f.contents.clicks).toEqual([{ nodeId: 7, x: 100, y: 220 }]);
    expect(f.contents.mouseEvents.filter((event) => event.type === 'mouseMoved')).toHaveLength(4);
  });

  it('rejects a target that keeps moving after three follow-up moves', async () => {
    const f = await setup();
    f.contents.onMove = () => {
      f.contents.point.y += 40;
    };
    await expect(f.act()).rejects.toMatchObject({
      ...stale,
      message: expect.stringContaining('kept moving'),
    });
    expect(f.contents.mouseEvents.filter((event) => event.type === 'mouseMoved')).toHaveLength(4);
    expect(f.contents.mouseEvents.filter((event) => event.type === 'mousePressed')).toEqual([]);
    expect(f.contents.hitPoints).toEqual([]);
    expect(f.contents.clicks).toEqual([]);
  });

  it('scrolls a target back into view after it moves outside the viewport', async () => {
    const f = await setup();
    let moved = false;
    f.contents.onMove = () => {
      if (!moved) {
        moved = true;
        f.contents.point.y = 700;
      }
    };
    await f.act();
    expect(f.contents.clicks).toEqual([{ nodeId: 7, x: 100, y: 400 }]);
  });

  it('rejects an identity change during a follow-up move', async () => {
    const f = await setup();
    let moves = 0;
    f.contents.onMove = () => {
      if (moves++ === 0) f.contents.point.y += 40;
      else f.contents.target.name = '删除';
    };
    await expect(f.act()).rejects.toMatchObject(stale);
    expect(f.contents.mouseEvents.filter((event) => event.type === 'mouseMoved')).toHaveLength(2);
    expect(f.contents.clicks).toEqual([]);
  });

  it('rejects a cover at the new point after following a moving target', async () => {
    const f = await setup();
    let moved = false;
    f.contents.onMove = () => {
      if (!moved) {
        moved = true;
        f.contents.point.y += 40;
      } else f.contents.covered = true;
    };
    await expect(f.act()).rejects.toMatchObject(stale);
    expect(f.contents.hitPoints).toEqual([{ x: 100, y: 140 }]);
    expect(f.contents.clicks).toEqual([]);
  });

  for (const effect of [
    { kind: 'type', text: '你好', replace: false },
    { kind: 'press', key: 'Enter', modifiers: [] },
    { kind: 'select', value: 'two' },
  ] satisfies BrowserEffect[]) {
    it(`follows a moving target before ${effect.kind}`, async () => {
      const f = await setup((c) => {
        c.target.nodeName = effect.kind === 'select' ? 'SELECT' : 'INPUT';
        c.target.role = effect.kind === 'select' ? 'combobox' : 'textbox';
        c.target.optionValues = ['one', 'two'];
      });
      let moved = false;
      f.contents.onMove = () => {
        if (!moved) {
          moved = true;
          f.contents.point.y += 40;
        }
      };
      await f.act(effect);
      expect(f.contents.hitPoints).toEqual([{ x: 100, y: 140 }]);
      expect(f.contents.focused).toBe(7);
      if (effect.kind === 'type') expect(f.contents.target.value).toBe('你好');
      else if (effect.kind === 'press') expect(f.contents.keys).toEqual(['Enter']);
      else expect(f.contents.target.value).toBe('two');
    });
  }
});
