import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentConfigSchema,
  AgentConversationInputSchema,
  BrowsingDataClearSchema,
  IPC,
  PreferencesTargetSchema,
  ResumeTaskInputSchema,
  TaskInputSchema,
  ToolRequestSchema,
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
 * under the same name. So this compares each group's source text directly, plus
 * (for entry.cts, which hand-copies the channels it uses into its own local `IPC` object
 * instead of importing the shared one) the actual string value each referenced channel
 * resolves to.
 */
function preloadGroupBlock(source: string, group: string): string {
  const label = `${group}: Object.freeze(`;
  const start = source.indexOf(label);
  if (start < 0) throw new Error(`${group} group not found in preload source`);
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

describe('preload parity', () => {
  const index = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/preload/entry.cts', import.meta.url), 'utf8');

  describe.each(['skills', 'updates', 'downloads', 'browsingData', 'schedules'])(
    '%s group',
    (group) => {
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

      it('resolves every IPC.* channel it references to the same string in both files', () => {
        const entryBlock = preloadGroupBlock(entry, group);
        const keys = [...new Set([...entryBlock.matchAll(/IPC\.(\w+)/g)].map((match) => match[1]))];
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
          expect(localIpcValue(entry, key)).toBe(IPC[key as keyof typeof IPC]);
        }
      });
    },
  );
});
