import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { TabRegistry } from '../src/main/browser/tab-registry';
import type { BrowserPagePort } from '../src/main/browser/types';

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
  ['missing', 'nonexistent-tab'],
  ['unauthorized', 'other-user-tab'],
] as const)('rejects %s external activation before stopping a user recording', (_kind, tabId) => {
  const test = runtime(true);
  expect(() => test.api.activateTab(tabId, 'external:client')).toThrow();
  expect(test.savedRecording).not.toHaveBeenCalled();
  expect(test.context.activeTabId).toBe('user-tab');
});

it.each(['nonexistent-tab', 'other-user-tab'])(
  'rejects external activation of %s without aborting user replay',
  (tabId) => {
    const test = runtime(false);
    expect(() => test.api.activateTab(tabId, 'external:client')).toThrow();
    expect(test.abort.signal.aborted).toBe(false);
    expect(test.context.activeTabId).toBe('user-tab');
  },
);

it('rejects external close before saving the user recording', async () => {
  const test = runtime(true);
  await expect(test.api.closeTab('user-tab', 'external:client')).rejects.toThrow();
  expect(test.savedRecording).not.toHaveBeenCalled();
  expect(test.registry.has('user-tab')).toBe(true);
});

it('rejects an observer close before aborting user replay', async () => {
  const test = runtime(false);
  test.registry.addAclEntry('user-tab', 'external:observer', 'observer');
  await expect(test.api.closeTab('user-tab', 'external:observer')).rejects.toThrow();
  expect(test.abort.signal.aborted).toBe(false);
  expect(test.registry.has('user-tab')).toBe(true);
});
