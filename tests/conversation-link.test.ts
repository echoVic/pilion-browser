import { describe, expect, it } from 'vitest';
import {
  conversationLinkState,
  focusedAgentStatus,
  type ConnectAttempt,
} from '../src/main/agents/conversation-link';

const bound = { agentId: 'claude', agentEnabled: true };
const attempts: Record<string, ConnectAttempt> = {
  connecting: { phase: 'connecting' },
  failed: { phase: 'failed', error: '握手超时' },
  capacity: { phase: 'capacity' },
};

describe('conversationLinkState', () => {
  it('a conversation with no agent, or whose agent is gone, never reports a connection state', () => {
    for (const attempt of [undefined, ...Object.values(attempts)]) {
      expect(conversationLinkState({ agentEnabled: true, attempt })).toEqual({ state: 'none' });
      expect(
        conversationLinkState({ agentId: 'claude', agentEnabled: false, attempt, live: undefined }),
      ).toEqual({ state: 'unavailable' });
    }
  });

  it('with nobody connecting it is disconnected, not connecting', () => {
    // 刚启动、手动断开之后：没有连接，也没有人在连。
    expect(conversationLinkState(bound)).toEqual({ state: 'disconnected' });
  });

  it('follows the attempt while there is no live connection', () => {
    expect(conversationLinkState({ ...bound, attempt: attempts.connecting })).toEqual({
      state: 'connecting',
    });
    expect(conversationLinkState({ ...bound, attempt: attempts.capacity })).toEqual({
      state: 'capacity',
    });
    expect(conversationLinkState({ ...bound, attempt: attempts.failed })).toEqual({
      state: 'failed',
      error: '握手超时',
    });
  });

  it('a live connection wins over any leftover attempt record', () => {
    for (const attempt of [undefined, ...Object.values(attempts)]) {
      expect(conversationLinkState({ ...bound, live: { running: false }, attempt })).toEqual({
        state: 'ready',
      });
      expect(conversationLinkState({ ...bound, live: { running: true }, attempt })).toEqual({
        state: 'running',
      });
    }
  });
});

describe('focusedAgentStatus', () => {
  it('says the same thing for the status bar', () => {
    expect(focusedAgentStatus({})).toBe('disconnected');
    expect(focusedAgentStatus({ attempt: attempts.connecting })).toBe('starting');
    expect(focusedAgentStatus({ attempt: attempts.failed })).toBe('error');
    expect(focusedAgentStatus({ attempt: attempts.capacity })).toBe('error');
    expect(focusedAgentStatus({ live: { running: false } })).toBe('ready');
    // goal 模式：prompt 已返回但任务还在跑，仍然是运行中。
    expect(focusedAgentStatus({ live: { running: true } })).toBe('running');
    expect(focusedAgentStatus({ live: { running: true }, attempt: attempts.failed })).toBe(
      'running',
    );
  });
});
