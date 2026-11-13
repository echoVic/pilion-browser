import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { TabRegistry } from '../src/main/browser/tab-registry';
import type { BrowserPagePort } from '../src/main/browser/types';
import { parseExternalPrincipal } from '../src/main/external/space-protocol';

function runtime(recording: boolean) {
  const registry = new TabRegistry();
  const page: BrowserPagePort = {
    snapshot: async () => ({ url: 'https://example.com/', title: 'Example', loading: false }),
    screenshot: async () => ({ mimeType: 'image/png', data: '' }),
    navigate: async () => {},
    observeElements: async () => [],
    elementFingerprint: async () => undefined,
    applyEffect: async () => {},
    setLifecycleListener() {},
    close() {},
  };
  registry.add('user-tab', page, 'local-user');
  registry.add('other-user-tab', page, 'local-user');
  const savedRecording = vi.fn(async () => {});
  const abort = new AbortController();
  const context = {
    USER_PRINCIPAL: 'local-user',
    activeTabId: 'user-tab',
    browser: {
      registry,
      closeTab: vi.fn(async (principal: string, tabId: string) => {
        registry.require(tabId, principal, 'manage');
        registry.remove(tabId);
      }),
    },
    recordingSession: {
      tabId: () => (recording ? 'user-tab' : undefined),
      leaveTab: savedRecording,
    },
    replay: recording ? undefined : { state: { status: 'running' }, abort },
    refreshSkills() {},
    emit() {},
    // 守卫之后才用到的名字也要在：守卫要是没拦住，测试看到的是真实的后续动作，而不是一个
    // ReferenceError 冒充「被拒绝了」。
    parseExternalPrincipal,
    tabSelectionVersion: 0,
    activeFind: undefined,
    findResult: undefined,
    pages: new Map(),
    tabOrganization: {
      activate: vi.fn(),
      remove: vi.fn(() => undefined),
      visibleIds: () => [] as string[],
    },
    backgroundTabs: { isWoken: () => false, hideNow: vi.fn(), forget: vi.fn() },
    rememberTabs: vi.fn(),
    layout: vi.fn(),
    tabOwnerPrincipal: () => undefined,
    shutdownPhase: 'running',
    closedTabs: [] as object[],
    HOME: 'about:blank',
    openTab: vi.fn(async () => 'fresh-tab'),
    sessions: new Map(),
    sessionRuntimes: { list: () => [], setAgentTab: vi.fn() },
  };
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [
    'activateTab',
    'closeTab',
    'stopTabWork',
    'forgetTab',
    'leaveRecordingTab',
    'autoRecordingName',
    'stopReplay',
    'replayRunning',
  ];
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  const api = runInNewContext(
    ts.transpileModule(
      functions.map((fn) => fn.getText(source)).join('\n') + '\n({activateTab, closeTab})',
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  ) as {
    activateTab(tabId: string, principal: string): void;
    closeTab(tabId: string, principal: string): Promise<void>;
  };
  return { api, context, abort, savedRecording, registry };
}

it.each([
  ['missing', 'nonexistent-tab', 'Tab does not exist'],
  ['unauthorized', 'other-user-tab', 'Principal lacks observe permission'],
] as const)(
  'rejects %s external activation before stopping a user recording',
  (_kind, tabId, message) => {
    const test = runtime(true);
    expect(() => test.api.activateTab(tabId, 'external:client')).toThrow(message);
    expect(test.savedRecording).not.toHaveBeenCalled();
    expect(test.context.activeTabId).toBe('user-tab');
  },
);

it.each([
  ['nonexistent-tab', 'Tab does not exist'],
  ['other-user-tab', 'Principal lacks observe permission'],
])('rejects external activation of %s without aborting user replay', (tabId, message) => {
  const test = runtime(false);
  expect(() => test.api.activateTab(tabId, 'external:client')).toThrow(message);
  expect(test.abort.signal.aborted).toBe(false);
  expect(test.context.activeTabId).toBe('user-tab');
});

it('rejects external close before saving the user recording', async () => {
  const test = runtime(true);
  await expect(test.api.closeTab('user-tab', 'external:client')).rejects.toThrow(
    'Principal lacks manage permission',
  );
  expect(test.savedRecording).not.toHaveBeenCalled();
  expect(test.registry.has('user-tab')).toBe(true);
});

it('rejects an observer close before aborting user replay', async () => {
  const test = runtime(false);
  test.registry.addAclEntry('user-tab', 'external:observer', 'observer');
  await expect(test.api.closeTab('user-tab', 'external:observer')).rejects.toThrow(
    'Principal lacks manage permission',
  );
  expect(test.abort.signal.aborted).toBe(false);
  expect(test.registry.has('user-tab')).toBe(true);
});

// 对照：同样的夹具里，有权限的激活和关闭能一路跑完——上面那些拒绝确实是守卫给的。
it('the same fixture lets an authorized activation and close run to completion', async () => {
  const test = runtime(true);
  test.api.activateTab('other-user-tab', 'local-user');
  expect(test.context.activeTabId).toBe('other-user-tab');
  expect(test.savedRecording).toHaveBeenCalledOnce();
  await test.api.closeTab('user-tab', 'local-user');
  expect(test.registry.has('user-tab')).toBe(false);
  expect(test.context.closedTabs).toHaveLength(0);
});
