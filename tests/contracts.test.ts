import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  AgentConversationInputSchema,
  BrowsingDataClearSchema,
  FileOpenInputSchema,
  IPC,
  MAX_UPLOAD_FILES,
  PermissionInputSchema,
  PreferencesTargetSchema,
  ResumeTaskInputSchema,
  ScreenshotArgsSchema,
  TaskInputSchema,
  ToolRequestSchema,
  UseAgentForConversationSchema,
} from '../src/shared/contracts';

describe('conversation-bound agent inputs', () => {
  it('carries the original conversation through prompt and control requests', () => {
    const conversationId = 'conversation-a';
    expect(AgentConversationInputSchema.parse({ conversationId })).toEqual({ conversationId });
    expect(TaskInputSchema.parse({ text: 'hello', conversationId })).toEqual({
      text: 'hello',
      conversationId,
    });
    expect(ResumeTaskInputSchema.parse({ conversationId })).toEqual({ text: '', conversationId });
    expect(AgentConversationInputSchema.parse(undefined)).toEqual({});
  });

  it.each([
    { conversationId: '' },
    { conversationId: 42 },
    { conversationId: 'a', principal: 'agent:b' },
    { conversationId: 'a', profileId: 'other' },
  ])('rejects malformed or authority-bearing input %j', (input) => {
    expect(AgentConversationInputSchema.safeParse(input).success).toBe(false);
    expect(TaskInputSchema.safeParse({ text: 'hello', ...input }).success).toBe(false);
    expect(ResumeTaskInputSchema.safeParse({ text: 'hello', ...input }).success).toBe(false);
  });

  it('bounds the conversation id the same way on every input that carries one', () => {
    const accepts = (conversationId: unknown) =>
      [
        AgentConversationInputSchema.safeParse({ conversationId }),
        TaskInputSchema.safeParse({ text: 'hello', conversationId }),
        ResumeTaskInputSchema.safeParse({ conversationId }),
        FileOpenInputSchema.safeParse({ href: 'a.md', conversationId }),
        PermissionInputSchema.safeParse({ mode: 'ask', conversationId }),
        UseAgentForConversationSchema.safeParse({ conversationId, agentId: 'agent-1' }),
      ].map((result) => result.success);
    expect(accepts('c'.repeat(256))).toEqual([true, true, true, true, true, true]);
    expect(accepts('c'.repeat(257))).toEqual([false, false, false, false, false, false]);
    expect(accepts('')).toEqual([false, false, false, false, false, false]);
    expect(
      UseAgentForConversationSchema.safeParse({ conversationId: 'c1', agentId: '' }).success,
    ).toBe(false);
  });
});

describe('browser settings inputs', () => {
  it('requires four booleans, at least one selected category and no extra fields', () => {
    const input = { history: true, downloads: false, cookies: false, cache: false };
    expect(BrowsingDataClearSchema.parse(input)).toEqual(input);
    for (const invalid of [
      { ...input, history: false },
      { ...input, history: 'yes' },
      { history: true },
      { ...input, partition: 'default' },
    ])
      expect(BrowsingDataClearSchema.safeParse(invalid).success).toBe(false);
    for (const key of ['history', 'downloads', 'cookies', 'cache']) {
      expect(
        BrowsingDataClearSchema.safeParse({
          history: false,
          downloads: false,
          cookies: false,
          cache: false,
          [key]: true,
        }).success,
      ).toBe(true);
    }
  });

  it('can open the browser pane directly', () => {
    expect(PreferencesTargetSchema.parse({ pane: 'browser' })).toEqual({ pane: 'browser' });
  });
});

/**
 * `entry.cts` is what Electron actually loads; `index.ts` only feeds the renderer's types.
 * They're kept in sync by hand, so a method added to one and not the other type-checks and
 * passes every unit test, then throws at runtime the first time the renderer calls it. A
 * matching method NAME doesn't prove a matching call, either: one side could pass a
 * differently shaped argument object, or resolve a channel constant to a different string,
 * under the same name. So this compares the source text of the whole bridge (every group,
 * every top-level method, the listeners set up beside it) and of each group on its own, plus
 * (for entry.cts, which hand-copies the channels it uses into its own local `IPC` object
 * instead of importing the shared one) the actual string value each channel resolves to.
 */
function preloadGroupBlock(source: string, group: string): string {
  return bracedBlock(source, `${group}: Object.freeze(`);
}

/** The `{...}` that follows `label`, braces included. */
function bracedBlock(source: string, label: string): string {
  const start = source.indexOf(label);
  if (start < 0) throw new Error(`${label} not found in preload source`);
  const open = source.indexOf('{', start + label.length);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open, end + 1);
}

function groupMethodNames(block: string): string[] {
  return [...block.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]).sort();
}

/** Reads `key: 'value'` out of entry.cts's own local `const IPC = {...}` literal. */
function localIpcValue(source: string, key: string): string | undefined {
  return source.match(new RegExp(`\\b${key}:\\s*'([^']*)'`))?.[1];
}

/** Every `key: 'value'` pair of entry.cts's own local `const IPC = {...}` literal. */
function localIpcTable(source: string): Map<string, string> {
  const table = bracedBlock(source, 'const IPC = ');
  return new Map(
    [...table.matchAll(/^ {2}(\w+): '([^']*)',$/gm)].map((match) => [match[1], match[2]]),
  );
}

/** The keys directly under `const api = Object.freeze({...})`: groups and top-level methods. */
function apiKeys(source: string): string[] {
  return [...bracedBlock(source, 'const api = Object.freeze(').matchAll(/^ {2}(\w+):/gm)]
    .map((match) => match[1])
    .sort();
}

/** The keys directly under `api` whose value is a frozen group of methods. */
function apiGroups(source: string): string[] {
  return [
    ...bracedBlock(source, 'const api = Object.freeze(').matchAll(/^ {2}(\w+): Object\.freeze\(/gm),
  ].map((match) => match[1]);
}

/**
 * Everything both files must share: the file minus its imports, entry.cts's local `IPC` table
 * and index.ts's type export.
 */
function preloadBody(source: string): string {
  return source
    .replace(/^import [\s\S]*?;\n/gm, '')
    .replace(/^const IPC = \{\n[\s\S]*?\n\} as const;\n/m, '')
    .replace(/^export type PilionApi = typeof api;\n/m, '')
    .trim();
}

const ref = {
  id: 'element-1',
  tabId: 'tab-1',
  frameId: 'main',
  documentEpoch: 1,
  frameEpoch: 0,
  localFingerprint: 'fingerprint-1',
};

import { ToolNameSchema } from '../src/shared/contracts';

describe('browser tool surface', () => {
  it('lets an Agent ask for a person without going through a page action', () => {
    expect(ToolNameSchema.safeParse('browser.request_human').success).toBe(true);
  });

  it('exposes the two skill tools and validates play arguments', () => {
    expect(ToolNameSchema.safeParse('browser.skills.list').success).toBe(true);
    expect(ToolNameSchema.safeParse('browser.skills.play').success).toBe(true);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r1',
        name: 'browser.skills.play',
        args: { skillId: 'monthly-export', fromStep: 3 },
      }).success,
    ).toBe(true);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r1',
        name: 'browser.skills.play',
        args: { skillId: 'monthly-export', fromStep: 0 },
      }).success,
    ).toBe(false);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r1',
        name: 'browser.skills.play',
        args: { skillId: '../x' },
      }).success,
    ).toBe(true); // id 形状由技能库 assertId 把关，这里只限长度
  });
});

describe('agent config', () => {
  it('rejects empty executable', () => {
    expect(() =>
      AgentConfigSchema.parse({ id: '1', name: 'x', command: '', args: [], enabled: true }),
    ).toThrow();
  });
  it('accepts explicit executable', () => {
    expect(
      AgentConfigSchema.parse({ id: '1', name: 'x', command: '/bin/x', enabled: true }).args,
    ).toEqual([]);
  });
});

describe('Browser effect schemas', () => {
  it('accepts select/check and a controlled press', () => {
    expect(
      ToolRequestSchema.parse({
        requestId: '1',
        name: 'browser.select',
        args: { elementRef: ref, value: 'prod' },
      }).name,
    ).toBe('browser.select');
    expect(
      ToolRequestSchema.parse({
        requestId: '2',
        name: 'browser.check',
        args: { elementRef: ref, checked: true },
      }).name,
    ).toBe('browser.check');
    expect(
      ToolRequestSchema.parse({
        requestId: '3',
        name: 'browser.press',
        args: { elementRef: ref, key: 'Enter', modifiers: ['Shift'] },
      }).name,
    ).toBe('browser.press');
  });

  it.each([
    { elementRef: ref, key: 'r', modifiers: ['Control'] },
    { elementRef: ref, key: 'F4', modifiers: ['Alt'] },
    { elementRef: ref, key: 'Enter', modifiers: ['Meta'] },
  ])('rejects system or non-allowlisted shortcuts: %j', (args) => {
    expect(() =>
      ToolRequestSchema.parse({ requestId: 'press', name: 'browser.press', args }),
    ).toThrow();
  });

  it('rejects malformed select/check arguments and unknown fields', () => {
    expect(() =>
      ToolRequestSchema.parse({
        requestId: 'select',
        name: 'browser.select',
        args: { elementRef: ref },
      }),
    ).toThrow();
    expect(() =>
      ToolRequestSchema.parse({
        requestId: 'check',
        name: 'browser.check',
        args: { elementRef: ref, checked: 'yes' },
      }),
    ).toThrow();
    expect(() =>
      ToolRequestSchema.parse({
        requestId: 'press',
        name: 'browser.press',
        args: { elementRef: ref, key: 'Enter', script: 'alert(1)' },
      }),
    ).toThrow();
  });
});

describe('issue #3 tool schema additions', () => {
  it('accepts browser.hover and requires its elementRef', () => {
    expect(ToolNameSchema.safeParse('browser.hover').success).toBe(true);
    expect(
      ToolRequestSchema.parse({
        requestId: 'h',
        name: 'browser.hover',
        args: { elementRef: ref },
      }).name,
    ).toBe('browser.hover');
    expect(() =>
      ToolRequestSchema.parse({ requestId: 'h2', name: 'browser.hover', args: {} }),
    ).toThrow();
  });

  it('accepts press without elementRef and click with a boolean force', () => {
    expect(
      ToolRequestSchema.parse({
        requestId: 'p',
        name: 'browser.press',
        args: { key: 'Space' },
      }).args,
    ).toMatchObject({ key: 'Space' });
    expect(
      ToolRequestSchema.parse({
        requestId: 'c',
        name: 'browser.click',
        args: { elementRef: ref, force: true },
      }).name,
    ).toBe('browser.click');
    expect(() =>
      ToolRequestSchema.parse({
        requestId: 'c2',
        name: 'browser.click',
        args: { elementRef: ref, force: 'yes' },
      }),
    ).toThrow();
  });
});

describe('preload parity', () => {
  const index = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/preload/entry.cts', import.meta.url), 'utf8');
  // Read from the file Electron loads, so a group added there is compared without editing this list.
  const groups = apiGroups(entry);

  it('exposes the same groups and top-level methods from both preload entry points', () => {
    // Guards the extraction itself: an empty list would make every check below pass vacuously.
    expect(groups).toEqual(
      expect.arrayContaining([
        'settings',
        'defaultBrowser',
        'updates',
        'workspace',
        'tabs',
        'spaces',
        'downloads',
        'browsingData',
        'browserData',
        'agents',
        'recording',
        'skills',
        'external',
        'files',
        'schedules',
      ]),
    );
    expect(apiGroups(index)).toEqual(groups);
    expect(apiKeys(entry)).toEqual(apiKeys(index));
    expect(apiKeys(entry)).toEqual(
      expect.arrayContaining(['onShortcut', 'onCommand', 'viewport', 'getState', 'onState']),
    );
  });

  // The per-group checks below name the group that drifted; this one also covers the top-level
  // methods and the `preferences:open` listener that sit outside any group.
  it('keeps the whole bridge byte-identical between the two entry points', () => {
    const body = preloadBody(entry);
    expect(body).toMatch(/^\/\/ /);
    expect(body).toContain('const api = Object.freeze({');
    expect(body).toMatch(/contextBridge\.exposeInMainWorld\('pilion', api\);$/);
    expect(body).toEqual(preloadBody(index));
  });

  it('gives every channel in the local IPC table of entry.cts the value from contracts.ts', () => {
    const table = localIpcTable(entry);
    const referenced = new Set(
      [...bracedBlock(entry, 'const api = Object.freeze(').matchAll(/IPC\.(\w+)/g)].map(
        (match) => match[1],
      ),
    );
    expect(table.size).toBeGreaterThan(0);
    for (const key of referenced) expect(table.has(key), key).toBe(true);
    for (const [key, value] of table) expect(value, key).toBe(IPC[key as keyof typeof IPC]);
  });

  describe.each(groups)('%s group', (group) => {
    it('exposes the same method names from both preload entry points', () => {
      const indexBlock = preloadGroupBlock(index, group);
      const entryBlock = preloadGroupBlock(entry, group);
      expect(groupMethodNames(entryBlock)).toEqual(groupMethodNames(indexBlock));
    });

    // A same-named method can still pass a differently shaped argument object on one side;
    // that's a schema rejection at runtime, not a typecheck or a method-name mismatch. Comparing
    // the full source text of both groups catches that, plus any other one-sided edit.
    it('keeps every method byte-identical between the two entry points', () => {
      const indexBlock = preloadGroupBlock(index, group);
      const entryBlock = preloadGroupBlock(entry, group);
      expect(entryBlock).toEqual(indexBlock);
    });

    // `workspace` and the local-agent setup calls still name their channels as literals on both
    // sides (contracts.ts has no constant for some of them); the byte-identical check covers those.
    it('resolves every IPC.* channel it references to the same string in both files', () => {
      const entryBlock = preloadGroupBlock(entry, group);
      const keys = [...new Set([...entryBlock.matchAll(/IPC\.(\w+)/g)].map((match) => match[1]))];
      for (const key of keys) {
        expect(localIpcValue(entry, key)).toBe(IPC[key as keyof typeof IPC]);
      }
    });
  });
});

describe('scroll and upload argument contracts', () => {
  const ref = {
    id: 'element-1',
    tabId: 'tab-1',
    frameId: 'main',
    documentEpoch: 0,
    frameEpoch: 0,
    localFingerprint: 'a'.repeat(64),
  };

  it('accepts a bounded scroll request and rejects unknown fields or directions', () => {
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r1',
        name: 'browser.scroll',
        args: { tabId: 'tab-1', direction: 'down' },
      }).success,
    ).toBe(true);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r2',
        name: 'browser.scroll',
        args: { tabId: 'tab-1', direction: 'sideways' },
      }).success,
    ).toBe(false);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r3',
        name: 'browser.scroll',
        args: { tabId: 'tab-1', direction: 'down', amount: 10_001 },
      }).success,
    ).toBe(false);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r4',
        name: 'browser.scroll',
        args: { tabId: 'tab-1', direction: 'down', elementRef: ref },
      }).success,
    ).toBe(false);
  });

  it('requires one to ten upload paths plus a full element ref', () => {
    const upload = (files: unknown) =>
      ToolRequestSchema.safeParse({
        requestId: 'r5',
        name: 'browser.upload_file',
        args: { tabId: 'tab-1', elementRef: ref, files },
      }).success;
    expect(upload(['/tmp/a.png'])).toBe(true);
    expect(upload([])).toBe(false);
    expect(upload(Array.from({ length: 11 }, (_, index) => `/tmp/${index}.png`))).toBe(false);
    expect(upload([''])).toBe(false);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r6',
        name: 'browser.upload_file',
        args: { elementRef: ref, files: ['/tmp/a.png'] },
      }).success,
    ).toBe(true);
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'r7',
        name: 'browser.upload_file',
        args: { files: ['/tmp/a.png'] },
      }).success,
    ).toBe(false);
  });

  it('keeps MAX_UPLOAD_FILES as the single shared limit and exposes too_big with its field path', () => {
    expect(MAX_UPLOAD_FILES).toBe(10);
    const make = (files: unknown) =>
      ToolRequestSchema.safeParse({
        requestId: 'r8',
        name: 'browser.upload_file',
        args: { elementRef: ref, files },
      });
    expect(make(Array.from({ length: MAX_UPLOAD_FILES }, (_, i) => `/tmp/${i}.png`)).success).toBe(
      true,
    );
    const tooBig = make(Array.from({ length: 16 }, (_, i) => `/tmp/${i}.png`));
    expect(tooBig.success).toBe(false);
    if (!tooBig.success)
      expect(
        tooBig.error.issues.some(
          (issue) => issue.code === 'too_big' && issue.path.join('.') === 'args.files',
        ),
      ).toBe(true);
  });
});

describe('screenshot argument contract', () => {
  const req = (args: Record<string, unknown>) =>
    ToolRequestSchema.safeParse({
      requestId: 'r1',
      name: 'browser.screenshot',
      args,
    }).success;

  it('accepts an empty args object and a bare tabId (backwards compatible)', () => {
    expect(ScreenshotArgsSchema.parse({})).toEqual({});
    expect(req({})).toBe(true);
    expect(req({ tabId: 't1' })).toBe(true);
  });

  it('accepts scale/quality/format/clip together within their bounds', () => {
    const args = {
      tabId: 't1',
      scale: 0.5,
      quality: 60,
      format: 'jpeg',
      clip: { x: 0, y: 0, width: 800, height: 600 },
    };
    expect(ScreenshotArgsSchema.parse(args)).toEqual(args);
    expect(req(args)).toBe(true);
    expect(req({ scale: 1, format: 'png' })).toBe(true);
    expect(req({ scale: 0.1, quality: 100 })).toBe(true);
  });

  it.each([
    { scale: 0 },
    { scale: 1.01 },
    { quality: 0 },
    { quality: 101 },
    { quality: 60.5 },
    { format: 'gif' },
    { clip: { x: -1, y: 0, width: 10, height: 10 } },
    { clip: { x: 0, y: 0, width: 0, height: 10 } },
    { clip: { x: 0, y: 0, width: 10 } },
    { clip: { x: 0, y: 0, width: 10, height: 10, scale: 0.5 } },
    { bogus: 1 },
  ])('rejects invalid screenshot args and unknown fields: %j', (args) => {
    expect(ScreenshotArgsSchema.safeParse(args).success).toBe(false);
    expect(req(args)).toBe(false);
  });

  it('surfaces a readable message for an out-of-range scale', () => {
    const parsed = ScreenshotArgsSchema.safeParse({ scale: 5 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/--scale/);
  });
});

describe('issue #7 browser.pointer schema', () => {
  const pointerRef = {
    id: 'e9',
    tabId: 't1',
    frameId: 'main',
    documentEpoch: 1,
    frameEpoch: 1,
    localFingerprint: 'fp',
  };
  const parse = (action: unknown, extra: Record<string, unknown> = {}) =>
    ToolRequestSchema.safeParse({
      requestId: 'p',
      name: 'browser.pointer',
      args: { elementRef: pointerRef, action, ...extra },
    });

  it('accepts each action shape within bounds', () => {
    expect(ToolNameSchema.safeParse('browser.pointer').success).toBe(true);
    for (const action of [
      { type: 'click', x: 0, y: 0 },
      { type: 'click', x: 120.5, y: 340, button: 'right', count: 2 },
      { type: 'click', x: 100_000, y: 100_000, button: 'middle', count: 3 },
      { type: 'move', x: 1, y: 2 },
      { type: 'drag', from: { x: 10, y: 10 }, to: { x: 200, y: 150 } },
      { type: 'wheel', x: 5, y: 5, deltaY: -240 },
      { type: 'wheel', x: 5, y: 5, deltaX: 30, deltaY: 0 },
      // 超出 ±10000 的增量在主进程里夹紧，schema 只要求有限数。
      { type: 'wheel', x: 5, y: 5, deltaY: 50_000 },
    ])
      expect(parse(action, { tabId: 't1' }).success, JSON.stringify(action)).toBe(true);
  });

  it('rejects out-of-range or non-finite coordinates, unknown fields and bad options', () => {
    for (const action of [
      { type: 'click', x: -1, y: 0 },
      { type: 'click', x: 100_001, y: 0 },
      { type: 'click', x: Number.NaN, y: 0 },
      { type: 'click', x: Number.POSITIVE_INFINITY, y: 0 },
      { type: 'click', x: '1', y: 0 },
      { type: 'click', x: 1 },
      { type: 'click', x: 1, y: 1, button: 'back' },
      { type: 'click', x: 1, y: 1, count: 4 },
      { type: 'click', x: 1, y: 1, count: 1.5 },
      { type: 'click', x: 1, y: 1, script: 'x' },
      { type: 'move', x: 1, y: 1, button: 'left' },
      { type: 'drag', from: { x: 1, y: 1 } },
      { type: 'drag', from: { x: 1, y: 1 }, to: { x: -5, y: 1 } },
      { type: 'drag', from: { x: 1, y: 1, z: 0 }, to: { x: 5, y: 1 } },
      { type: 'drag', x: 1, y: 1, from: { x: 1, y: 1 }, to: { x: 5, y: 1 } },
      { type: 'wheel', x: 1, y: 1 },
      { type: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 0 },
      { type: 'wheel', x: 1, y: 1, deltaY: Number.NaN },
      { type: 'tap', x: 1, y: 1 },
      {},
    ])
      expect(parse(action).success, JSON.stringify(action)).toBe(false);
  });

  it('requires the element ref and refuses unknown top-level fields', () => {
    expect(
      ToolRequestSchema.safeParse({
        requestId: 'p',
        name: 'browser.pointer',
        args: { action: { type: 'click', x: 1, y: 1 } },
      }).success,
    ).toBe(false);
    expect(parse({ type: 'click', x: 1, y: 1 }, { force: true }).success).toBe(false);
    expect(parse({ type: 'click', x: 1, y: 1 }, { selector: 'canvas' }).success).toBe(false);
  });
});
