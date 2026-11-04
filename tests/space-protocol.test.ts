import { describe, expect, it } from 'vitest';
import { externalErrorDiagnostics } from '../src/main/external/client.js';
import {
  AgentSpaceError,
  ControlFrameSchema,
  SPACE_MESSAGES,
  externalSpacePrincipal,
  parseExternalPrincipal,
} from '../src/main/external/space-protocol.js';
import {
  BrowserSpaceSchema,
  DEFAULT_SPACE,
  SpaceCreateSchema,
  SpaceEditSchema,
  TabStateSchema,
  isAgentSpace,
} from '../src/shared/tab-organization.js';

const agent = { clientId: 'c1', label: '比价', createdAt: 1, state: 'active' as const };

describe('sub-principals', () => {
  it('round-trips client and space ids', () => {
    expect(externalSpacePrincipal('c1', 'agent-x')).toBe('external:c1:agent-x');
    expect(parseExternalPrincipal('external:c1:agent-x')).toEqual({
      clientId: 'c1',
      spaceId: 'agent-x',
    });
    expect(parseExternalPrincipal('external:c1')).toEqual({ clientId: 'c1' });
  });
  it.each(['local-user', 'agent:x:y', 'external:', 'external:c1:', 'external:c1:a:b'])(
    'rejects %s',
    (value) => expect(parseExternalPrincipal(value)).toBeUndefined(),
  );
});

describe('AgentSpaceError', () => {
  it('carries a code that crosses the external boundary', () => {
    const error = new AgentSpaceError('SPACE_NOT_FOUND');
    expect(error.message).toBe(SPACE_MESSAGES.SPACE_NOT_FOUND);
    expect(externalErrorDiagnostics(error)).toEqual({ code: 'SPACE_NOT_FOUND' });
  });
});

describe('control frames', () => {
  it('accepts the three ops', () => {
    for (const control of [
      { op: 'space.create', label: '比价' },
      { op: 'space.list' },
      { op: 'space.close', spaceId: 'agent-1' },
    ])
      expect(ControlFrameSchema.parse({ id: '1', control }).control).toEqual(control);
  });
  it.each([
    { id: '1', control: { op: 'space.nuke' } },
    { id: '1', control: { op: 'space.create', label: '' } },
    { id: '1', control: { op: 'space.create', label: 'x'.repeat(41) } },
    { id: '1', control: { op: 'space.list', extra: true } },
    { id: '1', control: { op: 'space.list' }, request: {} },
  ])('rejects %j', (frame) => expect(ControlFrameSchema.safeParse(frame).success).toBe(false));
});

describe('agent space schema', () => {
  it('persists the agent field and recognises agent spaces', () => {
    const space = BrowserSpaceSchema.parse({
      id: 'agent-1',
      name: '比价',
      color: 'neutral',
      agent,
    });
    expect(space.agent).toEqual(agent);
    expect(isAgentSpace(space)).toBe(true);
    expect(isAgentSpace(DEFAULT_SPACE)).toBe(false);
  });
  it('keeps the renderer from creating or forging agent spaces', () => {
    expect(SpaceCreateSchema.safeParse({ name: 'x', color: 'teal', agent }).success).toBe(false);
    expect(SpaceEditSchema.safeParse({ id: 'a', name: 'x', color: 'teal', agent }).success).toBe(
      false,
    );
  });
  it('loads old tab state without agent fields and caps spaces at 40', () => {
    const base = { activeSpaceId: 'default', tabs: [], archivedTabs: [] };
    expect(TabStateSchema.parse({ ...base, spaces: [DEFAULT_SPACE] }).spaces[0]).toEqual(
      DEFAULT_SPACE,
    );
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `s${i}`, color: 'teal' as const }));
    expect(TabStateSchema.safeParse({ ...base, spaces: many(40) }).success).toBe(true);
    expect(TabStateSchema.safeParse({ ...base, spaces: many(41) }).success).toBe(false);
  });
});
