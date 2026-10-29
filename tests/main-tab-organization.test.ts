import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { TabOrganization } from '../src/main/browser/tab-organization';
import type { TabMetadata } from '../src/shared/tab-organization';

it('command focus returns only to the visible active page when it is not shielded', () => {
  const focusContents = vi.fn();
  const contents = {};
  const context = {
    activeTabId: 'a',
    pages: new Map([['a', { view: { webContents: contents, getVisible: (): boolean => true } }]]),
    viewport: { commandBarOpen: false },
    agentShield: { locked: false },
    focusContents,
  };
  load('focusActivePage', context);
  const focus = (context as Record<string, unknown>).focusActivePage as () => void;
  focus();
  expect(focusContents).toHaveBeenCalledWith(contents);
  focusContents.mockClear();
  context.viewport.commandBarOpen = true;
  focus();
  context.viewport.commandBarOpen = false;
  context.agentShield.locked = true;
  focus();
  context.agentShield.locked = false;
  context.pages.get('a')!.view.getVisible = () => false;
  focus();
  expect(focusContents).not.toHaveBeenCalled();
});

const source = ts.createSourceFile(
  'main.ts',
  readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function load(name: string, context: Record<string, unknown>) {
  const fn = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(fn).toBeDefined();
  runInNewContext(
    ts.transpileModule(fn!.getText(source), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    context,
  );
}

it.each(['tool', 'approval'])(
  'manual archive preserves the active page with a pending %s after the Agent moves on',
  async (pending) => {
    const organization = new TabOrganization();
    organization.add('a', { spaceId: 'default', kind: 'today', lastActiveAt: 0 });
    if (pending === 'tool') organization.beginUse('a', 100);
    const closeTab = vi.fn();
    const context: Record<string, unknown> = {
      activeTabId: 'a',
      tabOrganization: organization,
      pages: new Map([
        [
          'a',
          {
            model: { title: 'Example', url: 'https://example.com/', loading: false },
            view: { webContents: { isCurrentlyAudible: () => false } },
          },
        ],
      ]),
      sessions: new Map([['agent', { agentTabId: 'b' }]]),
      approvals: new Map(
        pending === 'approval' ? [['approval', { kind: 'browser', tabId: 'a' }]] : [],
      ),
      recordingSession: { tabId: () => undefined },
      replayRunning: () => false,
      randomUUID: () => 'archive',
      USER_PRINCIPAL: 'user',
      HOME: 'about:blank',
      closeTab,
      archivedTabs: [],
      rememberTabs() {},
      emit() {},
    };
    load('protectedArchiveTabs', context);
    load('archiveTab', context);
    await expect((context.archiveTab as (id: string) => Promise<void>)('a')).rejects.toThrow(
      '正在使用',
    );
    expect(closeTab).not.toHaveBeenCalled();
  },
);

it('the real tool boundary protects concurrent pages until each invocation finishes', async () => {
  const organization = new TabOrganization();
  const hour = 3_600_000;
  for (const id of ['a', 'b'])
    organization.add(id, { spaceId: 'default', kind: 'today', lastActiveAt: 0 });
  const complete = new Map<string, () => void>();
  const context: Record<string, unknown> = {
    tabOrganization: organization,
    pages: new Map([
      ['a', {}],
      ['b', {}],
    ]),
    recordingSession: { isRecording: () => false },
    USER_PRINCIPAL: 'user',
    agentReplay: undefined,
    agentReplayStarting: false,
    replayRunning: () => false,
    distillation: {},
    connBySessionId: () => undefined,
    connection: undefined,
    emit() {},
    viewport: { commandBarOpen: false },
    Date: { now: () => 25 * hour },
    targetTab: (request: { args: { tabId: string } }) => request.args.tabId,
    runTool: (request: { args: { tabId: string } }) =>
      new Promise<void>((resolve) => {
        complete.set(request.args.tabId, resolve);
      }),
  };
  load('executeTool', context);
  const execute = context.executeTool as (request: object, actor: object) => Promise<unknown>;
  const actor = { principal: 'agent', sessionId: 's', attachmentId: 'attachment' };
  const first = execute({ name: 'browser.screenshot', args: { tabId: 'a' } }, actor);
  const second = execute({ name: 'browser.screenshot', args: { tabId: 'b' } }, actor);
  expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual([]);
  complete.get('a')!();
  await first;
  expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual(['a']);
  complete.get('b')!();
  await second;
  expect(organization.archiveCandidates(50 * hour, 24, new Set())).toEqual(['a', 'b']);
});

it('closing the selected tab activates its successor and remembers it in the space', async () => {
  const organization = new TabOrganization();
  organization.createSpace('阅读', 'blue', 'reading');
  for (const id of ['a', 'b', 'c'])
    organization.add(id, { kind: 'today', spaceId: 'default', lastActiveAt: 0 });
  organization.activate('b', 10);
  const pages = new Map(
    ['a', 'b', 'c'].map((id) => [id, { model: { id, title: id, url: 'https://example.com' } }]),
  );
  const context: Record<string, unknown> = {
    activeTabId: 'b',
    tabOrganization: organization,
    pages,
    USER_PRINCIPAL: 'user',
    tabOwnerPrincipal: () => 'user',
    HOME: 'about:blank',
    draining: false,
    recordingSession: { tabId: () => undefined },
    replayRunning: () => false,
    closedTabs: [],
    activeFind: undefined,
    browser: { registry: { require: () => ({}) }, closeTab: async () => {} },
    backgroundTabs: { forget() {} },
    sessions: new Map(),
    sessionRuntimes: { list: () => [] },
    rememberTabs() {},
    layout() {},
    emit() {},
  };
  const activate = vi.fn((id: string) => {
    context.activeTabId = id;
    organization.activate(id, 100);
  });
  context.activateTab = activate;
  load('closeTab', context);
  await (context.closeTab as (id: string) => Promise<void>)('b');
  expect(activate).toHaveBeenCalledWith('c');
  organization.selectSpace('reading');
  expect(organization.selectSpace('default')).toBe('c');
  expect(organization.get('c').lastActiveAt).toBe(100);
});

it('a delayed new tab remains in its requested space without stealing a later selection', async () => {
  const organization = new TabOrganization();
  organization.createSpace('阅读', 'blue', 'reading');
  organization.add('reading-tab', { kind: 'today', spaceId: 'reading', lastActiveAt: 0 });
  let complete: ((value: { tabId: string; url: string }) => void) | undefined;
  const pending = new Promise<{ tabId: string; url: string }>((resolve) => {
    complete = resolve;
  });
  const view = {};
  const page = { view };
  const pages = new Map<string, { model: { id: string; title: string; url: string } }>();
  const context: Record<string, unknown> = {
    activeTabId: undefined,
    tabSelectionVersion: 0,
    tabOrganization: organization,
    pages,
    USER_PRINCIPAL: 'user',
    HOME: 'about:blank',
    connection: undefined,
    browser: { openTab: () => pending, registry: { get: () => ({ page }) } },
    pageFactory: { pages: [page] },
    replayRunning: () => false,
    leaveRecordingTab: vi.fn(),
    sync() {},
    layout() {},
    emit() {},
    bindPage: (id: string, _view: unknown, url: string, metadata?: TabMetadata) => {
      organization.add(
        id,
        metadata ?? { spaceId: organization.activeSpaceId, kind: 'today', lastActiveAt: 0 },
      );
      pages.set(id, { model: { id, title: '新标签页', url } });
    },
  };
  load('openTab', context);
  const opening = (context.openTab as () => Promise<string>)();
  organization.selectSpace('reading');
  organization.activate('reading-tab', 100);
  context.activeTabId = 'reading-tab';
  context.tabSelectionVersion = Number(context.tabSelectionVersion) + 1;
  complete!({ tabId: 'new-tab', url: 'about:blank' });
  await opening;
  expect(organization.get('new-tab').spaceId).toBe('default');
  expect(context.activeTabId).toBe('reading-tab');
  expect(organization.activeSpaceId).toBe('reading');
  expect(context.leaveRecordingTab).not.toHaveBeenCalled();
});

it('the first Agent tab stays in the space where its creation was requested', async () => {
  const organization = new TabOrganization();
  organization.createSpace('阅读', 'blue', 'reading');
  let complete: ((value: { tabId: string; url: string }) => void) | undefined;
  const pending = new Promise<{ tabId: string; url: string }>((resolve) => {
    complete = resolve;
  });
  const page = { view: {} };
  const pageFactory = { pages: [] as (typeof page)[] };
  const context: Record<string, unknown> = {
    tabOrganization: organization,
    pages: new Map(),
    pageFactory,
    USER_PRINCIPAL: 'user',
    browser: { openTab: () => pending, setTabAcl() {}, registry: { get: () => ({ page }) } },
    bindPage: (id: string, _view: unknown, _url: string, metadata: TabMetadata) =>
      organization.add(id, metadata),
    leaveRecordingTab() {},
    backgroundTabs: { register() {} },
    rememberTabs() {},
    emit() {},
    layout() {},
  };
  load('openAgentTab', context);
  const opening = (context.openAgentTab as (principal: string, url: string) => Promise<string>)(
    'user',
    'https://example.com/',
  );
  organization.selectSpace('reading');
  pageFactory.pages.push(page);
  complete!({ tabId: 'agent-tab', url: 'https://example.com/' });
  await opening;
  expect(organization.get('agent-tab').spaceId).toBe('default');
});
