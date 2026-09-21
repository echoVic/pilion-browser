import { describe, expect, it } from 'vitest';
import { AgentConfigSchema, ToolRequestSchema } from '../src/shared/contracts';

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
