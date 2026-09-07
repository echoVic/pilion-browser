import { describe, expect, it } from 'vitest';
import {
  HostError,
  actionDigest,
  assertTransition,
  canonicalCommandHash,
  canonicalEncode,
  canonicalizeCommand,
  canTransition,
  classifySemanticRisk,
  evaluatePolicy,
  type CanonicalCommandV1,
} from '../src/main/host/index';

const command: CanonicalCommandV1 = {
  schemaVersion: '1',
  tool: { name: 'browser.click', version: '1' },
  arguments: { b: 2, a: 1 },
  profileId: 'profile',
  sessionId: 'session',
  tabId: 'tab',
  target: {
    origin: 'https://example.com/path',
    documentEpoch: 'doc',
    frameId: 'main',
    frameEpoch: 1,
    elementRef: 'element',
    localFingerprint: 'fingerprint',
  },
  effect: 'page-mutating',
  dataFlow: { source: 'agent', destination: 'page', classifications: ['public'] },
  obligations: [{ type: 'revalidate_target', parameters: {} }],
};

describe('Host Core 状态机与 canonical digest', () => {
  it('仅允许规格中的状态转换', () => {
    expect(canTransition('session', 'creating', 'active')).toBe(true);
    expect(canTransition('attachment', 'detached', 'attached')).toBe(false);
    expect(canTransition('action', 'awaiting_approval', 'executing')).toBe(false);
    expect(canTransition('attempt', 'effect_started', 'outcome_unknown')).toBe(true);
    expect(() => assertTransition('action', 'succeeded', 'executing')).toThrowError(HostError);
    try {
      assertTransition('action', 'succeeded', 'executing');
    } catch (error) {
      expect((error as HostError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('稳定编码不受对象 key 顺序影响，并覆盖完整绑定', () => {
    expect(canonicalEncode({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    const reordered = { ...command, arguments: { a: 1, b: 2 } };
    expect(canonicalCommandHash(command)).toBe(canonicalCommandHash(reordered));
    expect(actionDigest({ command, policySetVersion: 'v1' })).not.toBe(
      actionDigest({ command: { ...command, tabId: 'other' }, policySetVersion: 'v1' }),
    );
    expect(canonicalizeCommand(command).target.origin).toBe('https://example.com');
  });

  it('语义风险与 Policy fail-closed，不依赖 click 工具名放行', () => {
    const payment = classifySemanticRisk({
      operation: 'click',
      accessibleName: '确认付款',
      targetOrigin: 'https://shop.example',
      changesExternalState: true,
    });
    expect(payment.effect).toBe('external-side-effect');
    expect(payment.highRisk).toBe(true);
    expect(
      evaluatePolicy({
        classification: payment,
        policySetVersion: 'v1',
        policyLoaded: true,
        trustedApprovalAvailable: true,
        contextComplete: true,
      }).verdict,
    ).toBe('require_approval');
    expect(
      evaluatePolicy({
        classification: payment,
        policySetVersion: 'v1',
        policyLoaded: true,
        trustedApprovalAvailable: false,
        contextComplete: true,
      }).verdict,
    ).toBe('deny');
    expect(
      evaluatePolicy({
        policyLoaded: false,
        trustedApprovalAvailable: true,
        contextComplete: false,
      }).verdict,
    ).toBe('deny');
  });

  it('敏感输入、缺失语义和任意外部副作用均默认要求审批', () => {
    const password = classifySemanticRisk({
      operation: 'type',
      elementRole: 'textbox',
      accessibleName: 'Password',
      inputType: 'password',
      targetOrigin: 'https://accounts.example',
      changesExternalState: true,
      classifierConfident: true,
    });
    expect(password.reasons).toContain('SENSITIVE_INPUT');
    expect(
      evaluatePolicy({
        classification: password,
        policyLoaded: true,
        trustedApprovalAvailable: true,
        contextComplete: true,
      }).verdict,
    ).toBe('require_approval');

    const missingSemantics = classifySemanticRisk({
      operation: 'click',
      targetOrigin: 'https://example.com',
      classifierConfident: false,
    });
    expect(missingSemantics.certain).toBe(false);
    expect(
      evaluatePolicy({
        classification: missingSemantics,
        policyLoaded: true,
        trustedApprovalAvailable: true,
        contextComplete: false,
      }).verdict,
    ).toBe('require_approval');

    const external = classifySemanticRisk({
      operation: 'custom-action',
      elementRole: 'button',
      accessibleName: 'Continue',
      targetOrigin: 'https://example.com',
      changesExternalState: true,
      classifierConfident: true,
    });
    expect(external.effect).toBe('external-side-effect');
    expect(
      evaluatePolicy({
        classification: external,
        policyLoaded: true,
        trustedApprovalAvailable: true,
        contextComplete: true,
      }).verdict,
    ).toBe('require_approval');
  });
});
