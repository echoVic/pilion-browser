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
