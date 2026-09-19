import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApprovalResponseSchema, IPC, ToolRequestSchema } from '../src/shared/contracts';

describe('MVP integration security boundary', () => {
  it('accepts only the fixed Browser Tool surface', () => {
    expect(
      ToolRequestSchema.parse({ requestId: 'r1', name: 'browser.observe', args: {} }).name,
    ).toBe('browser.observe');
    expect(() =>
      ToolRequestSchema.parse({ requestId: 'r2', name: 'browser.execute', args: { code: '1+1' } }),
    ).toThrow();
    expect(() =>
      ToolRequestSchema.parse({
        requestId: 'r3',
        name: 'browser.observe',
        args: {},
        principal: 'forged',
      }),
    ).toThrow();
  });

  it('binds approval response to nonce, digest and gesture token', () => {
    const valid = {
      approvalId: crypto.randomUUID(),
      nonce: 'n'.repeat(32),
      actionDigest: 'a'.repeat(64),
      decision: 'approve',
      gestureToken: crypto.randomUUID(),
    };
    expect(ApprovalResponseSchema.parse(valid)).toEqual(valid);
    expect(() => ApprovalResponseSchema.parse({ ...valid, actionDigest: 'changed' })).toThrow();
    expect(() => ApprovalResponseSchema.parse({ ...valid, gestureToken: undefined })).toThrow();
  });

  it('keeps IPC channels fixed and does not expose principal/profile inputs', () => {
    expect(Object.values(IPC).every((channel) => !channel.includes('*'))).toBe(true);
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
    expect(preload).not.toMatch(/principal|profileId|clipboard/);
  });

  it('has no executeJavaScript bypass and uses the narrow CDP adapter', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const adapter = readFileSync(
      new URL('../src/main/browser/electron-page-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(main + adapter).not.toContain('executeJavaScript');
    expect(adapter).not.toContain("'Runtime.evaluate'");
    expect(adapter).toContain("'DOM.querySelectorAll'");
    expect(adapter).toContain("'Input.dispatchMouseEvent'");
    expect(adapter).toContain("'Input.dispatchKeyEvent'");
    expect(adapter).toContain('PRESS_KEYS.includes(effect.key)');
  });

  it('routes DNS and redirects through one canonical URL policy', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const adapter = readFileSync(
      new URL('../src/main/browser/electron-page-adapter.ts', import.meta.url),
      'utf8',
    );
    const networkBoundary = readFileSync(
      new URL('../src/main/browser/network-boundary.ts', import.meta.url),
      'utf8',
    );
    const controlledProxy = readFileSync(
      new URL('../src/main/browser/controlled-proxy.ts', import.meta.url),
      'utf8',
    );
    expect(main).toContain('canonicalizeUrl(url, { resolver })');
    expect(main).toMatch(
      /new BrowserService\(\{\s*pageFactory,\s*grantVerifier:\s*verifier\(\),\s*resolver,\s*authorizePrincipal:\s*authorizeBrowserPrincipal,\s*\}\)/,
    );
    expect(main).toContain('installNetworkBoundary(persistent)');
    expect(main).toContain("proxyBypassRules: '<-loopback>'");
    expect(main).toContain('await persistent.setProxy');
    expect(controlledProxy).toContain('resolvePinnedTarget');
    expect(controlledProxy).toContain('host: target.address');
    expect(networkBoundary).toContain('target.webRequest.onBeforeRequest');
    expect(networkBoundary).toContain("'ws://*/*'");
    expect(adapter).toContain("contents.on('will-redirect', guard)");
    expect(adapter).toContain('this.validateUrl(url)');
  });

  it('keeps WebRTC from opening a UDP path around the controlled proxy', () => {
    const adapter = readFileSync(
      new URL('../src/main/browser/electron-page-adapter.ts', import.meta.url),
      'utf8',
    );
    expect(adapter).toContain("setWebRTCIPHandlingPolicy('disable_non_proxied_udp')");
  });

  it('binds execution to the original immutable tab and builds trusted redacted approval context', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('performTool(input.request, input.current.principal, input.tabId)');
    expect(main).toContain("throw new Error('执行阶段 tabId 与 Intent 绑定不一致')");
    expect(main).toContain('await browser.describeElement(current.principal, tabId, elementRef)');
    expect(main).toContain('text-sha256:');
    expect(main).not.toContain('summary: JSON.stringify(input.request.args');
  });

  it('revokes ACL before stopping failed transports and expired attachments', () => {
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const failure = main.slice(
      main.indexOf('async function failConnection'),
      main.indexOf('async function disconnectAgent'),
    );
    expect(failure.indexOf('revokeAgentAcls()')).toBeLessThan(
      failure.indexOf('await transport.stop()'),
    );
    expect(main).toContain("error instanceof HostError && error.code === 'LEASE_EXPIRED'");
  });

  it('renders approvals in the trusted renderer and resolves requests by ID', () => {
    const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const approval = readFileSync(
      new URL('../src/renderer/InlineApproval.tsx', import.meta.url),
      'utf8',
    );
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    expect(index).toContain("default-src 'none'");
    expect(main).toContain('approvalSender(event, response.approvalId)');
    expect(main).toContain('trustedRenderer(event)');
    expect(main).not.toContain('approvalWindow');
    expect(approval).toContain('批准一次');
    expect(approval).toContain('event.nativeEvent.isTrusted');
  });
});
