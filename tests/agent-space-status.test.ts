import { expect, it } from 'vitest';
import { agentSpaceStatus, AGENT_SPACE_STATUS_TEXT } from '../src/renderer/agent-space-status';
import { STATUS_TEXT } from '../src/renderer/task-overview';
import type { AgentBrowserSpace } from '../src/shared/tab-organization';

const space = (agent: Partial<AgentBrowserSpace['agent']>): AgentBrowserSpace => ({
  id: 's1',
  name: '比价',
  color: 'teal',
  agent: { clientId: 'c1', label: '比价', createdAt: 1, state: 'active', ...agent },
});

it('derives one status per space, with takeover first', () => {
  expect(agentSpaceStatus(space({}))).toBe('running');
  expect(
    agentSpaceStatus(space({}), [
      { state: 'pending', spaceId: 's1' },
      { state: 'approved', spaceId: 's1' },
    ]),
  ).toBe('confirm');
  expect(agentSpaceStatus(space({}), [{ state: 'denied', spaceId: 's1' }])).toBe('running');
  expect(agentSpaceStatus(space({ takenOverAt: 5 }), [{ state: 'pending', spaceId: 's1' }])).toBe(
    'held',
  );
  expect(agentSpaceStatus(space({ state: 'ended', endReason: 'handed_back', endedAt: 2 }))).toBe(
    'recoverable',
  );
  expect(agentSpaceStatus(space({ state: 'ended', endReason: 'idle', endedAt: 2 }))).toBe('ended');
});

it('uses the task overview wording everywhere', () => {
  for (const status of ['held', 'confirm', 'running', 'recoverable'] as const)
    expect(AGENT_SPACE_STATUS_TEXT[status]).toBe(STATUS_TEXT[status]);
  expect(AGENT_SPACE_STATUS_TEXT.held).toBe('已接管 · 待交还');
});
