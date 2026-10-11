import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it } from 'vitest';
import type { AgentPointer } from '../src/main/browser/agent-pointer';
import { BrowserService } from '../src/main/browser/browser-service';
import { ElectronPagePort } from '../src/main/browser/electron-page-adapter';
import type { BrowserEffect } from '../src/main/browser/types';

type Point = { x: number; y: number };
type ScriptedNode = {
  nodeId: number;
  nodeName: string;
  attributes: Record<string, string>;
  name: string;
  role: string;
  checked?: boolean;
  pressed?: boolean | 'mixed';
  url?: string;
  optionValues?: string[];
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
  clicks: Array<{ nodeId: number } & Point> = [];
  mouseEvents: Array<{ type: string } & Point> = [];
  hitPoints: Point[] = [];
  keys: string[] = [];
  focused?: number;
  scrolls = 0;
  commands: string[] = [];
  private down?: number;

  readonly debugger = {
    isAttached: () => true,
    attach: () => undefined,
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      this.commands.push(method);
      const id = params.nodeId;
      if (id !== undefined && id !== 1 && id !== this.target.nodeId)
        throw new Error('Could not find node with given id');
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1, nodeName: '#document' } };
        case 'DOM.querySelectorAll':
          return { nodeIds: params.selector === '*' ? [8] : [this.target.nodeId] };
        case 'DOM.describeNode':
          return {
            node: {
              nodeId: this.target.nodeId,
              nodeName: this.target.nodeName,
              attributes: Object.entries(this.target.attributes).flat(),
              children:
                Number(params.depth) > 0
                  ? this.target.optionValues?.map((value, index) => ({
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
          return {
            nodes: [
              {
                role: { value: this.target.role },
                name: { value: this.target.name },
                properties: ['checked', 'pressed', 'url'].flatMap((name) => {
                  const value = this.target[name as 'checked' | 'pressed' | 'url'];
                  return value === undefined ? [] : [{ name, value: { value } }];
                }),
              },
            ],
          };
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
            this.down = undefined;
          }
          return {};
        }
        case 'DOM.focus':
          this.focused = Number(id);
          return {};
        case 'Input.insertText':
          this.target.value = String(params.text);
          return {};
        case 'Input.dispatchKeyEvent':
          if (params.type === 'keyDown') this.keys.push(String(params.key));
          return {};
        case 'DOM.resolveNode':
          return { object: { objectId: String(id) } };
        case 'Runtime.callFunctionOn': {
          const value = (params.arguments as Array<{ value: string }>)[0].value;
          this.target.value = value;
          return { result: { value } };
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
  return { contents, port, ref, prepare, execute, act };
}

const stale = { code: 'STALE_ELEMENT', retryable: true };

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
