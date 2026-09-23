import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, rm, readFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');
/** Set PILION_E2E_EXECUTABLE to a packaged Pilion binary to run this suite against the built app. */
const packagedExecutable = process.env.PILION_E2E_EXECUTABLE;
const launchTarget = (args: string[]) =>
  packagedExecutable
    ? { executablePath: packagedExecutable, args }
    : { args: [projectRoot, ...args] };

/**
 * Playwright lists every page-type target as a window, including tab views and native overlays,
 * and their creation order differs between source and packaged builds. Pick the renderer that
 * exposes window.pilion instead of assuming it is the first window.
 */
async function resolveMainPage(app: ElectronApplication): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const isShell = await page
            .evaluate(() => typeof window.pilion === 'object')
            .catch(() => false);
          if (isShell) {
            found = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

let application: ElectronApplication | undefined;
let profileDirectory: string | undefined;
let mainPage: Page | undefined;

test.beforeEach(async () => {
  profileDirectory = await mkdtemp(join(tmpdir(), 'pilion-e2e-'));
  const bin = join(profileDirectory, 'bin');
  await mkdir(bin);
  const presetAgent = join(bin, 'fixture-agent.mjs');
  await writeFile(
    presetAgent,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(join(projectRoot, 'tests/fixtures/e2e-agent.mjs')).href)};\n`,
    { mode: 0o755 },
  );
  await symlink(presetAgent, join(bin, 'claude-agent-acp'));
  application = await electron.launch({
    ...launchTarget([`--user-data-dir=${profileDirectory}`, '--no-first-run']),
    cwd: projectRoot,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'test' },
    timeout: 30_000,
  });
  mainPage = await resolveMainPage(application);
  await mainPage.waitForLoadState('domcontentloaded');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs.length)),
    )
    .toBe(1);
});

test('workspace browsing, streamed conversation, cancellation and restore', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const errors: string[] = [];
  mainPage.on('pageerror', (error) => errors.push(error.message));
  const config = {
    id: 'workspace-agent',
    name: 'Workspace ACP Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  };
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), config);
  await mainPage.getByLabel('选择 Agent').selectOption(config.id);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.bookmarks?.length)),
    )
    .toBe(1);
  await mainPage.getByRole('button', { name: '书签', exact: true }).click();
  await expect(mainPage.getByRole('heading', { name: '书签' })).toBeVisible();
  await expect
    .poll(() =>
      application!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.every((view) => !view.getVisible()),
      ),
    )
    .toBe(true);
  await mainPage.getByRole('button', { name: '浏览器', exact: false }).first().click();
  await mainPage.getByLabel('输入任务').fill('总结页面');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('Example Domain');
  await expect(
    mainPage.locator('.message.assistant').last().getByRole('heading', { name: '页面摘要' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  const conversation = await mainPage.evaluate(() =>
    window.pilion
      .getState()
      .then((state) => state.conversations?.find((item) => item.id === state.activeConversationId)),
  );
  expect(
    conversation?.messages.filter(
      (item) => item.role === 'assistant' && item.text.includes('页面摘要'),
    ),
  ).toHaveLength(1);
  await mainPage.getByRole('button', { name: '复制回复' }).last().click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    'Example Domain',
  );
  await mainPage.getByLabel('输入任务').fill('等待取消');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.getByRole('button', { name: '停止任务' })).toBeVisible();
  const duplicate = await mainPage.evaluate(() =>
    window.pilion.agents.task('duplicate').then(
      () => 'accepted',
      (error) => String(error),
    ),
  );
  expect(duplicate).toContain('请等待当前任务结束');
  await mainPage.getByRole('button', { name: '停止任务' }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await mainPage.getByRole('button', { name: '新对话', exact: true }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion.getState().then((state) => state.activeConversationId),
      ),
    )
    .not.toBe(conversation?.id);
  await mainPage.getByRole('button', { name: '管理 Agent' }).click();
  await expect(mainPage.getByRole('heading', { name: 'Agent 连接' })).toBeVisible();
  await expect(mainPage.getByLabel('本地 Agent', { exact: true })).toBeVisible();
  await mainPage.getByRole('button', { name: '自定义 / 远端' }).click();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-settings.png') });
  await mainPage.getByRole('button', { name: '添加 Agent', exact: true }).click();
  await mainPage.getByRole('button', { name: '远端 SSH', exact: true }).click();
  await expect(mainPage.getByLabel('SSH 主机')).toBeVisible();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-remote.png') });
  await mainPage.getByRole('button', { name: '关闭设置' }).click();
  await mainPage.getByRole('button', { name: '新建标签页', exact: true }).first().click();
  await expect(mainPage.getByRole('heading', { name: '新标签页' })).toBeVisible();
  await mainPage.getByRole('button', { name: '收起协作栏' }).click();
  await expect(mainPage.getByLabel('Pilion AI 工作区')).not.toBeVisible();
  await mainPage.getByRole('button', { name: '打开 Agent 面板' }).click();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 720),
  );
  await expect(mainPage.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
  await mainPage.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(
    mainPage.getByRole('button', { name: 'Agent 连接', exact: false }).first(),
  ).toBeVisible();
  await mainPage.getByRole('button', { name: '收起侧边栏' }).click();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-narrow.png') });
  expect(
    await mainPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 900),
  );
  await mainPage.getByRole('button', { name: '主题：跟随系统' }).click();
  await mainPage.getByRole('button', { name: '主题：浅色' }).click();
  await expect(mainPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-dark.png') });
  expect(errors).toEqual([]);
  await application.close();
  application = undefined;
  const saved = JSON.parse(await readFile(join(profileDirectory, 'workspace.json'), 'utf8'));
  expect(
    saved.conversations.some((item: { messages: { text: string }[] }) =>
      item.messages.some((message) => message.text.includes('页面摘要')),
    ),
  ).toBe(true);
  expect(saved.bookmarks).toHaveLength(1);
  application = await electron.launch({
    ...launchTarget([`--user-data-dir=${profileDirectory}`]),
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  mainPage = await resolveMainPage(application);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs.length)),
    )
    .toBe(saved.tabs.length);
  expect(
    await mainPage.evaluate(() =>
      window.pilion.getState().then((state) => state.bookmarks?.length),
    ),
  ).toBe(1);
});

test.afterEach(async () => {
  if (application) {
    for (const page of application.windows()) {
      if (page !== mainPage && !page.url().startsWith('data:'))
        await page.close().catch(() => undefined);
    }
    await application.close().catch(() => application?.process().kill('SIGKILL'));
    application = undefined;
  }
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
});

test('built-in local Agent selection resolves runtime and establishes an ACP session', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.getByLabel('选择 Agent').selectOption('preset:claude');
  await expect(mainPage.getByLabel('本地 Agent', { exact: true })).toHaveValue('claude');
  await expect(mainPage.getByLabel('本地 Agent', { exact: true }).locator('option')).toHaveText([
    'Claude Code',
    'Codex',
    'Gemini CLI',
    'Grok Build',
    'OpenCode',
    'Pi',
    'Orca',
    'Blade',
  ]);
  for (const preset of ['grok', 'opencode', 'pi', 'orca', 'blade']) {
    await mainPage.getByLabel('本地 Agent', { exact: true }).selectOption(preset);
    await expect(mainPage.getByLabel('本地 Agent', { exact: true })).toHaveValue(preset);
  }
  await mainPage.getByLabel('本地 Agent', { exact: true }).selectOption('claude');
  await expect(mainPage.getByText('已检测到 ACP 程序', { exact: true })).toBeVisible();
  const runtime = await mainPage.evaluate(() => window.pilion.agents.inspectLocal());
  expect(runtime.nodePath).toBeTruthy();
  await mainPage.getByLabel('Node.js 路径').fill('/missing/node');
  await expect(mainPage.getByText('Node.js 需要配置', { exact: true })).toBeVisible();
  await expect(mainPage.getByRole('button', { name: '连接', exact: true })).toBeDisabled();
  await mainPage.getByLabel('Node.js 路径').fill('');
  await expect(mainPage.getByText('已检测到 ACP 程序', { exact: true })).toBeVisible();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-local-agents.png') });
  await mainPage.getByRole('button', { name: '连接', exact: true }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.connectedAgentId)),
    )
    .toBe('local:claude');
  await expect(mainPage.getByRole('heading', { name: '新标签页' })).toBeVisible();
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByLabel('输入任务').fill('总结页面');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant')).toContainText('Example Domain');
  const config = await mainPage.evaluate(() =>
    window.pilion
      .getState()
      .then((state) => state.agents.find((agent) => agent.id === 'local:claude')),
  );
  expect(config?.preset).toBe('claude');
  expect(config?.cwd).toContain('workspace-files');
});

test('built Electron MVP enforces its integration boundary', async () => {
  if (!application || !mainPage) throw new Error('Electron application did not launch');

  await expect(mainPage).toHaveTitle('Pilion Browser');
  await expect(mainPage.getByRole('heading', { name: 'Agent' })).toBeVisible();
  await expect(mainPage.getByLabel('Pilion AI 工作区')).toBeVisible();
  await expect
    .poll(async () => {
      const state = await mainPage!.evaluate(() => window.pilion.getState());
      return { tabs: state.tabs.length, active: Boolean(state.activeTabId) };
    })
    .toEqual({ tabs: 1, active: true });

  const visualStructure = await mainPage.evaluate(() => {
    const chrome = document.querySelector<HTMLElement>('.browser-chrome');
    const panel = document.querySelector<HTMLElement>('.ai-workspace');
    const omnibox = document.querySelector<HTMLElement>('.address-form');
    if (!chrome || !panel || !omnibox) throw new Error('Browser chrome structure is missing');
    const omniboxStyle = getComputedStyle(omnibox);
    return {
      chromeHeight: chrome.getBoundingClientRect().height,
      panelWidth: panel.getBoundingClientRect().width,
      omniboxRadius: Number.parseFloat(omniboxStyle.borderRadius),
      omniboxBackground: omniboxStyle.backgroundColor,
    };
  });
  // The window opens at 1440x900, but smaller displays such as CI runners clamp it into the
  // responsive layout, where the Agent panel narrows to 330px.
  const windowWidth = await application.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds().width,
  );
  expect(visualStructure.chromeHeight).toBe(52);
  expect(visualStructure.panelWidth, `window width ${windowWidth}`).toBe(
    windowWidth > 1180 ? 368 : 330,
  );
  expect(visualStructure.omniboxRadius).toBe(7);
  expect(visualStructure.omniboxBackground).not.toBe('rgba(0, 0, 0, 0)');

  await mainPage.screenshot({
    path: join(projectRoot, 'test-results', 'pilion-browser-renderer.png'),
  });

  await mainPage.getByLabel('地址栏').fill('https://example.com');
  await mainPage.getByLabel('地址栏').press('Enter');
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion.getState().then((state) => ({
          url: state.tabs[0]?.url,
          loading: state.tabs[0]?.loading,
        })),
      ),
    )
    .toEqual({ url: 'https://example.com/', loading: false });

  await mainPage.getByLabel('浏览器工具').click();
  await mainPage.getByRole('button', { name: '页内查找' }).click();
  await mainPage.getByLabel('在页面中查找').fill('Example');
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion.getState().then((state) => state.findResult?.matches ?? 0),
      ),
    )
    .toBeGreaterThan(0);
  await mainPage.getByLabel('关闭页内查找').click();

  await mainPage.getByLabel('浏览器工具').click();
  await mainPage.getByLabel('放大页面').click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => {
        const state = window.pilion.getState();
        return state.then(
          (snapshot) =>
            snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.zoomPercent ?? 0,
        );
      }),
    )
    .toBe(110);
  await mainPage.getByRole('button', { name: '110%' }).click();
  await mainPage.evaluate(() => window.pilion.tabs.duplicate());
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs.length)),
    )
    .toBe(2);
  const duplicated = await mainPage.evaluate(() => window.pilion.getState());
  await mainPage.evaluate((id) => window.pilion.tabs.close(id), duplicated.activeTabId!);
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion.getState().then((state) => ({
          count: state.tabs.length,
          canReopen: state.canReopenClosedTab,
        })),
      ),
    )
    .toEqual({ count: 1, canReopen: true });
  await mainPage.evaluate(() => window.pilion.tabs.reopenClosed());
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs.length)),
    )
    .toBe(2);
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion
          .getState()
          .then((state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.url),
      ),
    )
    .toBe('https://example.com/');

  await application.evaluate(({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.getURL() === 'https://example.com/');
    if (!contents) throw new Error('Example page is missing');
    contents.downloadURL('https://example.com/');
  });
  await expect
    .poll(
      () =>
        mainPage!.evaluate(() =>
          window.pilion.getState().then((state) => state.downloads?.[0]?.status),
        ),
      { timeout: 20_000 },
    )
    .toBe('completed');
  await mainPage.getByRole('button', { name: '下载', exact: true }).click();
  await expect(mainPage.getByRole('heading', { name: '下载' })).toBeVisible();
  await expect(mainPage.getByText('已完成', { exact: false }).first()).toBeVisible();
  await mainPage.getByRole('button', { name: '浏览器', exact: false }).first().click();

  const security = await application.evaluate(({ BrowserWindow, webContents }) => ({
    windows: BrowserWindow.getAllWindows().map((item) => ({
      url: item.webContents.getURL(),
      preferences: (
        item.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
      ).getLastWebPreferences(),
    })),
    contents: webContents.getAllWebContents().map((item) => ({
      url: item.getURL(),
      type: item.getType(),
      preferences: (
        item as unknown as { getLastWebPreferences(): Record<string, unknown> }
      ).getLastWebPreferences(),
    })),
  }));
  const shell = security.windows.find((item) => item.url.includes('dist-renderer/index.html'));
  expect(shell).toBeDefined();
  expect(shell?.preferences.sandbox).toBe(true);
  expect(shell?.preferences.contextIsolation).toBe(true);
  expect(shell?.preferences.nodeIntegration).toBe(false);

  const untrustedPage = security.contents.find((item) => /^https:\/\//.test(item.url));
  expect(untrustedPage).toBeDefined();
  expect(untrustedPage?.preferences.sandbox).toBe(true);
  expect(untrustedPage?.preferences.contextIsolation).toBe(true);
  expect(untrustedPage?.preferences.nodeIntegration).toBe(false);
  expect(untrustedPage?.preferences.preload).toBeUndefined();

  const preloadSurface = await mainPage.evaluate(() => ({
    root: Object.keys(window.pilion).sort(),
    tabs: Object.keys(window.pilion.tabs).sort(),
    downloads: Object.keys(window.pilion.downloads).sort(),
    agents: Object.keys(window.pilion.agents).sort(),
    cookies: Object.keys(window.pilion.cookies).sort(),
    clipboard: 'clipboard' in window.pilion,
  }));
  expect(preloadSurface).toEqual({
    root: [
      'agents',
      'cookies',
      'downloads',
      'getState',
      'onShortcut',
      'onState',
      'recording',
      'skills',
      'tabs',
      'viewport',
      'workspace',
    ],
    tabs: [
      'activate',
      'back',
      'close',
      'duplicate',
      'find',
      'forward',
      'navigate',
      'open',
      'reload',
      'reopenClosed',
      'resetZoom',
      'stop',
      'stopFind',
      'zoomIn',
      'zoomOut',
    ],
    downloads: ['cancel', 'clear', 'open', 'show', 'togglePause'],
    agents: [
      'approve',
      'attach',
      'cancel',
      'chooseDirectory',
      'configureLocal',
      'connect',
      'detach',
      'disconnect',
      'inspectLocal',
      'remove',
      'resume',
      'save',
      'setMode',
      'setModel',
      'takeOver',
      'task',
    ],
    cookies: ['chromeSources', 'importChrome'],
    clipboard: false,
  });
  // 渲染层的类型来自 src/preload/index.ts，真正加载的却是 src/preload/entry.cts；两者靠手抄
  // 保持一致，typecheck 看不出差异。这里钉住真实 bridge 暴露的方法名，只改一边就会在 E2E 失败，
  // 而不是到运行时才抛。
  const bridge = await mainPage.evaluate(() => ({
    recording: Object.keys(window.pilion.recording).sort(),
    skills: Object.keys(window.pilion.skills).sort(),
  }));
  expect(bridge).toEqual({
    recording: ['note', 'start', 'stop'],
    skills: [
      'discard',
      'distill',
      'events',
      'keep',
      'play',
      'read',
      'remove',
      'rename',
      'resume',
      'save',
      'show',
      'stop',
    ],
  });

  const config = {
    id: 'playwright-agent',
    name: 'Playwright ACP Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  };
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), config);
  await mainPage.getByLabel('选择 Agent').selectOption(config.id);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.attachmentStatus)),
    )
    .toBe('attached');

  const detach = mainPage.getByRole('button', { name: 'Detach' });
  const attach = mainPage.getByRole('button', { name: 'Attach' });
  await expect(detach).toBeEnabled();
  await detach.click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.attachmentStatus)),
    )
    .toBe('detached');
  await expect(attach).toBeEnabled();
  await attach.click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.attachmentStatus)),
    )
    .toBe('attached');

  await mainPage.getByLabel('权限类型').selectOption('ask');
  await expect(mainPage.getByLabel('权限类型')).toHaveValue('ask');
  await mainPage.getByPlaceholder('输入任务').fill('触发一次受控点击审批');
  await mainPage.getByRole('button', { name: '发送' }).click();
  await expect(mainPage.getByRole('region', { name: '操作审批' })).toBeVisible();
  await expect(mainPage.locator('.agent-operation-indicator strong')).toHaveText(
    'Agent 等待你确认',
  );
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentActivityPhase)),
    )
    .toBe('confirm');
  await expect(mainPage.getByRole('button', { name: '批准一次' })).toBeInViewport();
  expect(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
  await mainPage.locator('.inline-approval summary').click();
  await expect(mainPage.locator('.inline-approval pre')).toContainText('来源：可信页面快照');
  await expect(mainPage.locator('.inline-approval pre')).not.toContainText('elementRef');
  const stale = await mainPage.evaluate(() =>
    window.pilion.getState().then((state) => state.approvals[0]),
  );

  // Any origin other than example.com invalidates the pending approval. Try a second one when the
  // first navigation fails, so a slow external host does not fail the test on its own.
  const crossOriginErrors: string[] = [];
  for (const url of ['https://example.org', 'https://www.iana.org/help/example-domains']) {
    try {
      await mainPage.evaluate((target) => window.pilion.tabs.navigate(target), url);
      crossOriginErrors.length = 0;
      break;
    } catch (error) {
      crossOriginErrors.push(`${url}: ${String(error)}`);
    }
  }
  expect(crossOriginErrors, crossOriginErrors.join('\n')).toEqual([]);
  await expect
    .poll(
      () => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.approvals.length)),
    )
    .toBe(0);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  const replay = await mainPage.evaluate(
    (item) =>
      window.pilion.agents
        .approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve')
        .then(
          () => 'accepted',
          (error) => String(error),
        ),
    stale,
  );
  expect(replay).toContain('审批已结束');
});

test('composer controls apply permission and model, with approvals pinned in the Agent panel', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'controls-agent',
    name: 'Controls Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.getByLabel('选择 Agent').selectOption('controls-agent');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await expect(mainPage.locator('.composer').getByLabel('权限类型')).toHaveValue('full');
  await expect(mainPage.locator('.composer').getByLabel('模型')).toHaveValue('fixture-fast');
  await mainPage.getByLabel('模型').selectOption('fixture-reasoning');
  await expect(mainPage.getByLabel('模型')).toHaveValue('fixture-reasoning');
  await mainPage.getByLabel('输入任务').fill('ACP 审批');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('allow-once');
  await expect(mainPage.locator('.message.assistant').last()).toContainText('fixture-reasoning');
  await expect(mainPage.locator('.message.assistant').last()).toContainText('bypassPermissions');
  await expect(mainPage.locator('.inline-approval')).toHaveCount(0);
  await mainPage.getByLabel('权限类型').selectOption('ask');
  await mainPage.getByLabel('输入任务').fill('ACP 审批');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.inline-approval')).toBeVisible();
  expect(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  ).toBe(1);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 640),
  );
  await mainPage.locator('.inline-approval summary').click();
  await expect(mainPage.getByRole('button', { name: '批准一次' })).toBeInViewport();
  await expect(mainPage.getByRole('button', { name: '拒绝', exact: true })).toBeInViewport();
  await expect(mainPage.getByLabel('模型')).toBeInViewport();
  await expect(mainPage.getByLabel('权限类型')).toBeInViewport();
  await expect(mainPage.getByRole('button', { name: '停止任务' })).toBeInViewport({ ratio: 1 });
  const geometry = await mainPage.evaluate(() => ({
    height: innerHeight,
    elements: [...document.querySelector('.ai-workspace')!.children].map((element) => ({
      className: element.className,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      height: element.getBoundingClientRect().height,
    })),
  }));
  expect(geometry.elements.at(-1)!.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.height,
  );
  expect(await mainPage.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
    true,
  );
  await mainPage.screenshot({
    path: join(projectRoot, 'test-results', 'pilion-inline-approval.png'),
  });
  await mainPage.getByRole('button', { name: '批准一次' }).click();
  await expect(mainPage.locator('.inline-approval')).toHaveCount(0);
  await expect(mainPage.locator('.message.assistant').last()).toContainText('"mode":"default"');
  await mainPage.getByLabel('输入任务').fill('ACP 审批');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await mainPage.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('reject-once');
  await mainPage.getByLabel('权限类型').selectOption('full');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.permissionMode)),
    )
    .toBe('full');
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion.getState().then((state) => {
          const tab = state.tabs.find((item) => item.id === state.activeTabId);
          return { url: tab?.url, loading: tab?.loading };
        }),
      ),
    )
    .toEqual({ url: 'https://example.com/', loading: false });
  await mainPage.getByLabel('输入任务').fill('浏览器自动批准');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText(
    'Browser click completed',
  );
  await expect(mainPage.locator('.inline-approval')).toHaveCount(0);
});

test('Agent navigates from a blank tab, reads the page and follows a real link through MCP', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'blank-tab-agent',
    name: 'Blank Tab Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.getByLabel('选择 Agent').selectOption('blank-tab-agent');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await mainPage.getByLabel('输入任务').fill('空白页浏览验收');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('空白页验收完成');
  await expect(mainPage.locator('.message.assistant').last()).toContainText('Example Domain');
  await expect
    .poll(() =>
      application!.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .some((contents) =>
            contents.getURL().startsWith('https://www.iana.org/help/example-domains'),
          ),
      ),
    )
    .toBe(true);
});

test('empty ACP replies fail once without a hidden retry and remain explicitly resumable', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'recovery-agent',
    name: 'Recovery Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('recovery-agent'));
  await mainPage.getByLabel('输入任务').fill('空回复续接');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message-error')).toContainText('没有返回可展示内容');
  await expect(mainPage.locator('.message.user')).toHaveCount(1);
  await expect(mainPage.locator('.tool-message')).toHaveCount(1);
  await expect(mainPage.locator('.transcript')).not.toContainText('(no content)');
  const state = await mainPage.evaluate(() => window.pilion.getState());
  const messages = state.conversations!.find(
    (item) => item.id === state.activeConversationId,
  )!.messages;
  expect(new Set(messages.map((item) => item.id)).size).toBe(messages.length);
  expect(state.events.filter((item) => item.includes('ACP → session/prompt request'))).toHaveLength(
    1,
  );
  expect(state.agentStatus).toBe('ready');
  expect(
    state.conversations!.find((item) => item.id === state.activeConversationId)!.task?.status,
  ).toBe('manual');
  await expect(mainPage.getByRole('button', { name: '继续任务' })).toBeVisible();
});

test('negotiated Agent goals continue after the control request and complete asynchronously', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'goal-agent',
    name: 'Goal Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    env: { PILION_E2E_GOAL: '1' },
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('goal-agent'));
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByLabel('输入任务').fill('Goal 生命周期验收');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion
          .getState()
          .then(
            (state) =>
              state.conversations?.find((item) => item.id === state.activeConversationId)?.task
                ?.status,
          ),
      ),
    )
    .toBe('running');
  await expect(mainPage.locator('.message.assistant').last()).toContainText(
    'Goal completed for Example Domain',
  );
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion
          .getState()
          .then(
            (state) =>
              state.conversations?.find((item) => item.id === state.activeConversationId)?.task
                ?.status,
          ),
      ),
    )
    .toBe('completed');
  const state = await mainPage.evaluate(() => window.pilion.getState());
  expect(state.agentStatus).toBe('ready');
  expect(state.events.some((item) => item.includes('session/prompt'))).toBe(false);
});

test('composer preserves native IME composition and commits Chinese text once', async () => {
  test.skip(
    Boolean(process.env.CI),
    'CDP IME composition emulation does not end composition on the GitHub macOS runner; run locally',
  );
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'ime-agent',
    name: 'IME Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('ime-agent'));
  const input = mainPage.getByLabel('输入任务');
  await input.click();
  const cdp = await mainPage.context().newCDPSession(mainPage);
  for (const text of ['n', 'ni', 'nihao', '你好']) {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await expect(input).toHaveValue(text);
  }
  await cdp.send('Input.insertText', { text: '你好' });
  await expect(input).toHaveValue('你好');
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }),
    ),
  );
  await expect(mainPage.locator('.message.user')).toHaveCount(0);
  await cdp.send('Input.imeSetComposition', { text: 'shijie', selectionStart: 6, selectionEnd: 6 });
  await expect(input).toHaveValue('你好shijie');
  await cdp.send('Input.insertText', { text: '世界' });
  await expect(input).toHaveValue('你好世界');
  await cdp.send('Input.imeSetComposition', { text: 'quxiao', selectionStart: 6, selectionEnd: 6 });
  await expect(input).toHaveValue('你好世界quxiao');
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect(input).toHaveValue('你好世界');
  await mainPage.getByRole('button', { name: '隐藏 Agent 面板', exact: true }).click();
  await mainPage.getByRole('button', { name: '打开 Agent 面板' }).click();
  await expect(input).toHaveValue('你好世界');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(mainPage.locator('.message.user')).toHaveCount(1);
  await expect(mainPage.locator('.message.user')).toHaveText('你好世界');
  await expect(mainPage.locator('.message.assistant')).toContainText('No interactive element');
  await cdp.detach();
});

test('composer still sends when the IME never reports the end of a composition', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'stale-ime-agent',
    name: 'Stale IME Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('stale-ime-agent'));
  const input = mainPage.getByLabel('输入任务');
  await input.click();
  await input.pressSequentially('你好');
  await expect(input).toHaveValue('你好');
  // A composition that starts and never ends leaves the composer waiting forever otherwise.
  await input.evaluate((element) =>
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
  );
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(mainPage.locator('.message.user')).toHaveText('你好');
});

test('a starter prompt points at the missing Agent instead of a dead composer', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.getByRole('button', { name: '总结当前页面' }).click();
  await expect(mainPage.getByText('还没有连接 Agent')).toBeVisible();
  await expect(mainPage.getByLabel('输入任务')).not.toHaveValue('');
  expect(await mainPage.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
    '选择 Agent',
  );
});

test('opening settings in a narrow window gives the form the room it needs', async () => {
  if (!application || !mainPage) throw new Error('Not launched');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(820, 720),
  );
  await expect(mainPage.getByLabel('输入任务')).toBeVisible();
  await mainPage.getByLabel('管理 Agent').click();
  await expect(mainPage.getByRole('heading', { name: 'Agent 连接' })).toBeVisible();
  await expect(mainPage.getByLabel('输入任务')).toBeHidden();
  expect(
    await mainPage.evaluate(
      () => document.querySelector('.local-agent-form, section')!.getBoundingClientRect().width,
    ),
  ).toBeGreaterThan(600);
});

test('importing Chrome cookies states the scope and waits for a confirmation', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs[0].loading)),
    )
    .toBe(false);
  await expect(mainPage.getByLabel('导入 Chrome cookie')).toHaveCount(0);
  await mainPage.getByLabel('从 Chrome 导入 cookie').click();
  const bar = mainPage.getByLabel('导入 Chrome cookie');
  await expect(bar).toBeVisible();
  // Nothing may be read before the confirmation, so the state stays untouched until then.
  await expect(bar).toContainText(/全部登录态|只支持 macOS|未找到本机 Chrome/);
  await mainPage.getByLabel('关闭导入提示').click();
  await expect(bar).toHaveCount(0);
});

test('an unconnected composer explains itself instead of replacing the page', async () => {
  if (!mainPage) throw new Error('Not launched');
  const input = mainPage.getByLabel('输入任务');
  await input.click();
  await input.pressSequentially('总结这个页面');
  await input.press('Enter');
  await expect(mainPage.getByText('还没有连接 Agent')).toBeVisible();
  await expect(mainPage.getByRole('heading', { name: 'Agent 连接' })).toHaveCount(0);
  await expect(input).toHaveValue('总结这个页面');
});

test('an Agent that still needs its adapter says so before the wait starts', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.getByLabel('选择 Agent').selectOption('preset:codex');
  await expect(mainPage.getByRole('heading', { name: 'Agent 连接' })).toBeVisible();
  await expect(mainPage.getByRole('button', { name: '安装并连接' })).toBeVisible();
  await expect(mainPage.getByText('首次安装适配器可能需要几分钟')).toBeVisible();
});

test('an Agent can ask for a person and is told what they did before it resumes', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((config) => window.pilion.agents.save(config), {
    id: 'handover-agent',
    name: 'Handover Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('handover-agent'));
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByLabel('输入任务').fill('这个站点需要登录');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();

  // The Agent hands the browser back and says why, without the person having to interrupt it.
  await expect(mainPage.locator('.message-error').last()).toContainText('需要你先登录');
  await expect(mainPage.getByRole('button', { name: '继续任务' })).toBeVisible();
  await expect
    .poll(() =>
      mainPage!.evaluate(() =>
        window.pilion
          .getState()
          .then(
            (state) =>
              state.conversations?.find((item) => item.id === state.activeConversationId)?.task
                ?.status,
          ),
      ),
    )
    .toBe('manual');

  await mainPage.evaluate(() =>
    window.pilion.tabs.navigate('https://www.iana.org/help/example-domains'),
  );
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs[0].loading)),
    )
    .toBe(false);
  // Handing back is the moment a note is worth asking for, so the panel says so and focuses it.
  await expect(mainPage.getByText('补充一句你刚才做了什么')).toBeVisible();
  expect(await mainPage.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
    '输入任务',
  );
  await mainPage.getByRole('button', { name: '继续任务' }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('iana.org');
});

test('takeover preserves the task, resume uses the new page, and stop ends it', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  await mainPage.evaluate((config) => window.pilion.agents.save(config), {
    id: 'takeover-agent',
    name: 'Takeover Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('takeover-agent'));
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  let turns = 0;
  for (const label of ['接管浏览器', '停止浏览器任务', '停止任务']) {
    await mainPage.getByLabel('输入任务').fill('接管等价验收');
    await mainPage.getByRole('button', { name: '发送', exact: true }).click();
    await expect(mainPage.locator('.message.assistant').last()).toContainText('已输出的内容');
    await expect(mainPage.getByRole('button', { name: '停止浏览器任务' })).toBeInViewport();
    await mainPage.getByRole('button', { name: label, exact: true }).click();
    await expect
      .poll(() =>
        mainPage!.evaluate(() => window.pilion.getState().then((state) => state.attachmentStatus)),
      )
      .toBe('detached');
    await expect
      .poll(() =>
        application!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some(
            (view) =>
              view.getVisible() &&
              (view as Electron.WebContentsView).webContents?.getTitle() === 'Pilion Agent Shield',
          ),
        ),
      )
      .toBe(false);
    await expect
      .poll(() =>
        mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
      )
      .toBe('ready');
    const state = await mainPage.evaluate(() => window.pilion.getState());
    const messages = state.conversations!.find(
      (item) => item.id === state.activeConversationId,
    )!.messages;
    expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(++turns);
    expect(messages.at(-1)).toMatchObject({ text: '已输出的内容', status: 'cancelled' });
    expect(messages.some((item) => item.text.includes('迟到'))).toBe(false);
    expect(state.connectedAgentId).toBe('takeover-agent');
    await expect(mainPage.getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
    const task = state.conversations!.find((item) => item.id === state.activeConversationId)!.task!;
    expect(task.status).toBe(label === '接管浏览器' ? 'manual' : 'stopped');
    if (label === '接管浏览器') {
      await expect(mainPage.getByRole('button', { name: '停止浏览器任务' })).toBeInViewport();
      await application.evaluate(async ({ webContents }) => {
        await webContents
          .getAllWebContents()
          .find((item) => item.getURL().startsWith('https://example.com'))!
          .executeJavaScript(
            'document.body.innerHTML="<h1>人工修改后的页面</h1><button>新的按钮</button>";void 0;',
          );
      });
      await mainPage.getByRole('button', { name: '继续任务', exact: true }).click();
      await expect(mainPage.locator('.message.assistant').last()).toContainText(
        '已读取最新页面并继续完成任务',
      );
      turns++;
      await expect
        .poll(() =>
          mainPage!.evaluate(() =>
            window.pilion
              .getState()
              .then(
                (state) =>
                  state.conversations!.find((item) => item.id === state.activeConversationId)!.task
                    ?.status,
              ),
          ),
        )
        .toBe('completed');
      const resumed = await mainPage.evaluate(() => window.pilion.getState());
      expect(
        resumed.conversations!.find((item) => item.id === resumed.activeConversationId)!.task?.id,
      ).toBe(task.id);
    } else {
      await expect(mainPage.getByRole('button', { name: '继续任务', exact: true })).toHaveCount(0);
      expect(
        await mainPage.evaluate(() =>
          window.pilion.agents.resume().then(
            () => false,
            () => true,
          ),
        ),
      ).toBe(true);
    }
  }
  await mainPage.getByLabel('输入任务').fill('总结页面');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('人工修改后的页面');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.attachmentStatus)),
    )
    .toBe('attached');
  await mainPage.getByLabel('输入任务').fill('接管等价验收');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('已输出的内容');
  await mainPage.getByRole('button', { name: '接管浏览器' }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await mainPage.evaluate(() => window.pilion.agents.disconnect());
  await mainPage.reload();
  await mainPage.getByRole('button', { name: '继续任务', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText(
    '已读取最新页面并继续完成任务',
  );
  await expect(mainPage.locator('.message-error')).toHaveCount(0);
});

test('browser controls read as unavailable while the Agent drives the page', async () => {
  if (!mainPage) throw new Error('Not launched');
  await mainPage.evaluate((config) => window.pilion.agents.save(config), {
    id: 'driving-agent',
    name: 'Driving Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('driving-agent'));
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs[0].loading)),
    )
    .toBe(false);
  await expect(mainPage.getByLabel('地址栏')).toBeEnabled();
  await mainPage.getByLabel('输入任务').fill('等待取消');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.getByLabel('接管浏览器')).toBeVisible();
  await expect(mainPage.getByLabel('地址栏')).toBeDisabled();
  await expect(mainPage.getByRole('button', { name: '刷新' })).toBeDisabled();
  await mainPage.getByRole('button', { name: '浏览器工具' }).click();
  await expect(mainPage.getByRole('button', { name: '页内查找' })).toBeDisabled();
  await mainPage.getByLabel('接管浏览器').click();
  await expect(mainPage.getByLabel('地址栏')).toBeEnabled();
});

test('Agent shield blocks manual page input and releases it on takeover', async () => {
  if (!application || !mainPage) throw new Error('Not launched');
  await mainPage.evaluate((config) => window.pilion.agents.save(config), {
    id: 'shield-agent',
    name: 'Shield Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.evaluate(() => window.pilion.agents.connect('shield-agent'));
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs[0].loading)),
    )
    .toBe(false);
  await application.evaluate(async ({ webContents }) => {
    const page = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith('https://example.com'))!;
    await page.executeJavaScript(
      `document.body.innerHTML='<style>body{margin:0;height:3000px}button{position:absolute;left:20px;top:20px;width:180px;height:50px}</style><button>人工按钮</button><input style="position:absolute;top:100px" value="原始内容">';globalThis.clicks=0;document.querySelector('button').onclick=()=>clicks++;document.querySelector('input').focus();void 0;`,
    );
    page.focus();
  });
  await mainPage.getByLabel('输入任务').fill('等待取消');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.getByRole('button', { name: '接管浏览器' })).toBeVisible();
  await expect(mainPage.locator('.agent-operation-indicator strong')).toHaveText('Agent 正在思考');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentActivityPhase)),
    )
    .toBe('think');
  const shield = await application.evaluate(async ({ BrowserWindow, webContents }) => {
    const parent = BrowserWindow.getAllWindows().find(
      (win) => win.getTitle() !== 'Pilion Agent Pointer',
    )!;
    const page = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith('https://example.com'))!;
    const views = parent.contentView.children.filter((view) => view.getVisible());
    const top = views.at(-1)! as Electron.WebContentsView;
    const pageView = views.find((view) => (view as Electron.WebContentsView).webContents === page)!;
    top.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 80,
      y: 45,
      button: 'left',
      clickCount: 1,
    });
    top.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 80,
      y: 45,
      button: 'left',
      clickCount: 1,
    });
    top.webContents.sendInputEvent({ type: 'mouseWheel', x: 80, y: 45, deltaY: 500 });
    top.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    page.focus();
    return {
      title: top.webContents.getTitle(),
      bounds: top.getBounds(),
      pageBounds: pageView.getBounds(),
      text: await top.webContents.executeJavaScript('document.body.innerText.trim()'),
      phase: await top.webContents.executeJavaScript('document.body.dataset.phase'),
    };
  });
  expect(shield.title).toBe('Pilion Agent Shield');
  expect(shield.bounds).toEqual(shield.pageBounds);
  expect(shield.text).toBe('');
  expect(shield.phase).toBe('think');
  const locked = await application.evaluate(async ({ webContents }) => {
    const page = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith('https://example.com'))!;
    return {
      focused: page.isFocused(),
      data: await page.executeJavaScript(
        '({clicks,text:document.querySelector("input").value,scrollY})',
      ),
    };
  });
  expect(locked).toEqual({ focused: false, data: { clicks: 0, text: '原始内容', scrollY: 0 } });
  await mainPage.getByRole('button', { name: '接管浏览器' }).click();
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  const released = await application.evaluate(async ({ BrowserWindow, webContents }) => {
    const parent = BrowserWindow.getAllWindows().find(
      (win) => win.getTitle() !== 'Pilion Agent Pointer',
    )!;
    const page = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith('https://example.com'))!;
    const visible = parent.contentView.children.filter((view) => view.getVisible());
    const top = visible.at(-1)! as Electron.WebContentsView;
    top.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 80,
      y: 45,
      button: 'left',
      clickCount: 1,
    });
    top.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 80,
      y: 45,
      button: 'left',
      clickCount: 1,
    });
    return { pageOnTop: top.webContents === page };
  });
  expect(released.pageOnTop).toBe(true);
  await expect
    .poll(() =>
      application!.evaluate(async ({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((wc) => wc.getURL().startsWith('https://example.com'))!
          .executeJavaScript('clicks'),
      ),
    )
    .toBe(1);
});

for (const zoom of [1, 1.25])
  test(`native Agent pointer follows real scrolled-page interactions at zoom ${zoom} and cleans up`, async () => {
    if (!application || !mainPage) throw new Error('Not launched');
    await mainPage.evaluate(
      ({ root, node }) =>
        window.pilion.agents.save({
          id: 'pointer-agent',
          name: 'Pointer Agent',
          command: node,
          args: [`${root}/tests/fixtures/e2e-agent.mjs`],
          cwd: root,
          enabled: true,
        }),
      { root: projectRoot, node: process.execPath },
    );
    await mainPage.evaluate(() => window.pilion.agents.connect('pointer-agent'));
    await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
    await expect
      .poll(() =>
        mainPage!.evaluate(() => window.pilion.getState().then((state) => state.tabs[0].loading)),
      )
      .toBe(false);
    await application.evaluate(async ({ webContents }, zoom) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith('https://example.com'))!;
      contents.setZoomFactor(zoom);
      await contents.executeJavaScript(
        `document.body.innerHTML = '<style>body{margin:0;font:16px sans-serif}main{margin:1200px 40px 500px;display:grid;gap:22px;width:300px}input,select,button{font:inherit;padding:12px}label{display:flex;gap:12px}</style><main><input aria-label="姓名"><select aria-label="类型"><option value="one">One</option><option value="two">Two</option></select><label><input type="checkbox" aria-label="同意测试">同意测试</label><button aria-label="显示结果">显示结果</button><output id="result">待操作</output></main>';globalThis.pointerEvents=[];document.addEventListener('mousemove',e=>pointerEvents.push({type:'move',x:e.clientX,y:e.clientY}));document.addEventListener('click',e=>pointerEvents.push({type:'click',label:e.target.getAttribute('aria-label'),x:e.clientX,y:e.clientY}));document.querySelector('button').onclick=()=>document.querySelector('output').textContent='完成：'+document.querySelector('input').value;void 0;`,
      );
    }, zoom);
    const samples: Array<{ visible: boolean; x: number; y: number; pulse: boolean }> = [];
    let pointerImage: string | undefined;
    let collecting = true;
    const collect = (async () => {
      while (collecting) {
        const sample = await application!.evaluate(async ({ BrowserWindow }) => {
          const pointer = BrowserWindow.getAllWindows().find(
            (item) => item.getTitle() === 'Pilion Agent Pointer',
          );
          return pointer && pointer.webContents.getURL().startsWith('data:')
            ? {
                visible: pointer.isVisible(),
                ...pointer.getBounds(),
                pulse: await pointer.webContents
                  .executeJavaScript(
                    'getComputedStyle(document.querySelector(".ring")).animationName === "ripple"',
                  )
                  .catch(() => false),
              }
            : null;
        });
        if (sample) samples.push(sample);
        if (sample?.visible && sample.pulse && !pointerImage) {
          pointerImage = await application!.evaluate(async ({ BrowserWindow }) => {
            const pointer = BrowserWindow.getAllWindows().find(
              (item) => item.getTitle() === 'Pilion Agent Pointer',
            )!;
            return (await pointer.webContents.capturePage()).toPNG().toString('base64');
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    try {
      await mainPage.getByLabel('输入任务').fill('鼠标交互验收');
      await mainPage.getByRole('button', { name: '发送', exact: true }).click();
      await expect
        .poll(
          () =>
            mainPage!.evaluate(() =>
              window.pilion.getState().then((state) => state.agentActivityPhase),
            ),
          { intervals: [10], timeout: 5_000 },
        )
        .toBe('act');
      await expect(mainPage.locator('.agent-operation-indicator strong')).toHaveText(
        'Agent 正在操作页面',
      );
      await expect(mainPage.locator('.message.assistant')).toContainText('鼠标交互验收完成');
    } finally {
      collecting = false;
      await collect;
    }
    const result = await application.evaluate(async ({ webContents, BrowserWindow }) => {
      const page = webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith('https://example.com'))!;
      const pointer = BrowserWindow.getAllWindows().find(
        (item) => item.getTitle() === 'Pilion Agent Pointer',
      )!;
      return {
        visible: pointer.isVisible(),
        focusable: pointer.isFocusable(),
        shieldVisible: pointer
          .getParentWindow()!
          .contentView.children.some(
            (view) =>
              view.getVisible() &&
              (view as Electron.WebContentsView).webContents?.getTitle() === 'Pilion Agent Shield',
          ),
        parent: pointer.getParentWindow()?.getTitle(),
        origin: (() => {
          const parent = pointer.getParentWindow()!;
          const view = parent.contentView.children.find(
            (child) =>
              'webContents' in child && (child as { webContents: unknown }).webContents === page,
          )!;
          return {
            x: parent.getContentBounds().x + view.getBounds().x,
            y: parent.getContentBounds().y + view.getBounds().y,
          };
        })(),
        page: await page.executeJavaScript(
          '({name:document.querySelector("input").value,type:document.querySelector("select").value,checked:document.querySelector("input[type=checkbox]").checked,result:document.querySelector("output").textContent,scrollY,events:pointerEvents})',
        ),
      };
    });
    expect(samples.filter((sample) => sample.visible).length).toBeGreaterThan(3);
    expect(
      new Set(samples.filter((sample) => sample.visible).map((sample) => `${sample.x},${sample.y}`))
        .size,
    ).toBeGreaterThan(3);
    expect(result.visible).toBe(false);
    expect(result.focusable).toBe(false);
    expect(result.shieldVisible).toBe(false);
    expect(samples.some((sample) => sample.visible && sample.pulse)).toBe(true);
    if (pointerImage)
      await writeFile(
        join(tmpdir(), `pilion-pointer-${zoom}.png`),
        Buffer.from(pointerImage, 'base64'),
      );
    expect(result.page).toMatchObject({
      name: '你好 Pilion',
      type: 'two',
      checked: true,
      result: '完成：你好 Pilion',
    });
    expect(result.page.scrollY).toBeGreaterThan(0);
    // The pointer animates in 12 steps, or a single step when the OS asks for reduced motion,
    // which the GitHub macOS runners do.
    const reducedMotion = await application.evaluate(
      ({ systemPreferences }) => systemPreferences.getAnimationSettings().prefersReducedMotion,
    );
    expect(
      result.page.events.filter((event: { type: string }) => event.type === 'move').length,
    ).toBeGreaterThan(reducedMotion ? 4 : 12);
    expect(
      result.page.events.filter((event: { label: string }) => event.label === '显示结果'),
    ).toHaveLength(1);
    const lastPointer = samples.filter((sample) => sample.visible && sample.pulse).at(-1)!;
    const click = result.page.events.find((event: { label: string }) => event.label === '显示结果');
    expect(Math.abs(lastPointer.x + 24 - result.origin.x - click.x * zoom)).toBeLessThan(2);
    expect(Math.abs(lastPointer.y + 24 - result.origin.y - click.y * zoom)).toBeLessThan(2);
    await mainPage.getByLabel('输入任务').fill('鼠标交互验收 取消');
    await mainPage.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .poll(
        () =>
          application!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().some(
              (item) => item.getTitle() === 'Pilion Agent Pointer' && item.isVisible(),
            ),
          ),
        { intervals: [10] },
      )
      .toBe(true);
    await mainPage.getByRole('button', { name: '接管浏览器', exact: true }).click();
    await expect
      .poll(() =>
        mainPage!.evaluate(() =>
          window.pilion
            .getState()
            .then((state) => ({ agent: state.agentStatus, attachment: state.attachmentStatus })),
        ),
      )
      .toEqual({ agent: 'ready', attachment: 'detached' });
    const stopped = await application.evaluate(async ({ BrowserWindow, webContents }) => ({
      visible: BrowserWindow.getAllWindows().some(
        (item) => item.getTitle() === 'Pilion Agent Pointer' && item.isVisible(),
      ),
      clicks: await webContents
        .getAllWebContents()
        .find((item) => item.getURL().startsWith('https://example.com'))!
        .executeJavaScript('pointerEvents.filter(event=>event.label === "显示结果").length'),
    }));
    expect(stopped).toEqual({ visible: false, clicks: 1 });
    await expect(mainPage.locator('.message-error')).toHaveCount(0);
  });

test('assistant-ui preserves drafts, IME input, streamed parts and manual scroll position', async () => {
  if (!mainPage) throw new Error('Not launched');
  const errors: string[] = [];
  mainPage.on('pageerror', (error) => errors.push(error.message));
  await mainPage.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'ui-agent',
    name: 'UI Agent',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await mainPage.getByLabel('选择 Agent').selectOption('ui-agent');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  const input = mainPage.getByLabel('输入任务');
  await input.fill('保留的草稿');
  await mainPage.getByRole('button', { name: '隐藏 Agent 面板', exact: true }).click();
  await mainPage.getByRole('button', { name: '打开 Agent 面板' }).click();
  await expect(input).toHaveValue('保留的草稿');
  await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    ),
  );
  await expect(input).toHaveValue('保留的草稿');
  await expect(mainPage.locator('.message.user')).toHaveCount(0);
  await input.fill('UI 回归');
  await input.press('Shift+Enter');
  await input.pressSequentially('第二行');
  await expect(input).toHaveValue('UI 回归\n第二行');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect(mainPage.locator('.message.user')).toHaveCount(1);
  await expect(mainPage.locator('.message.assistant')).toContainText('段落 20：');
  const viewport = mainPage.locator('.transcript');
  await viewport.hover();
  await mainPage.mouse.wheel(0, -10000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(40);
  await expect(mainPage.locator('.message.assistant')).toContainText('段落 80：');
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(40);
  await expect(mainPage.locator('.tool-message')).toContainText('读取页面');
  await mainPage.locator('.thought summary').click();
  await expect(mainPage.locator('.thought')).toContainText('检查页面和工具输出');
  await expect(mainPage.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  await mainPage.getByRole('button', { name: '回到最新消息' }).click();
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(5);
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-assistant-ui.png') });
  const conversationId = await mainPage.evaluate(() =>
    window.pilion.getState().then((state) => state.activeConversationId!),
  );
  await input.fill('只属于当前对话');
  await mainPage.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(mainPage.locator('.message.user')).toHaveCount(0);
  await expect
    .poll(() =>
      mainPage!.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)),
    )
    .toBe('ready');
  await mainPage.evaluate((id) => window.pilion.workspace.selectConversation(id), conversationId);
  await expect(input).toHaveValue('只属于当前对话');
  await expect(mainPage.locator('.message.assistant')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a person records a click, saves it as a skill, and replays it without an Agent', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 红框由可信 Renderer 画在页面之外：原生视图向内缩 2px 才让它露出来，所以这里量的是视图与
  // Renderer 页面区的差，停止录制后必须归零。
  const pageInset = async () => {
    const area = await shell.evaluate(() => {
      const rect = document.querySelector('.page-area')!.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y) };
    });
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows().find(
        (win) => win.getTitle() !== 'Pilion Agent Pointer',
      )!;
      const visible = parent.contentView.children.filter((view) => view.getVisible());
      return (visible.at(-1) as Electron.WebContentsView | undefined)?.getBounds();
    });
    return bounds ? { x: bounds.x - area.x, y: bounds.y - area.y } : undefined;
  };

  // 录制只能由人（可信 Renderer）开启；开启后 Agent 任务被拒。
  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);
  await expect(shell.evaluate(() => window.pilion.agents.task('hi'))).rejects.toThrow(/录制/);

  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().startsWith('https://example.com')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  // 地址栏导航是第 1 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);
  await expect.poll(pageInset).toEqual({ x: 2, y: 2 });

  await tabPage!.click('a');
  await expect.poll(() => tabPage!.url(), { timeout: 30_000 }).toContain('iana.org');
  // 人的点击是第 2 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(2);

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 点击'));
  expect(id).toBe('e2e-点击');
  await expect.poll(async () => (await state()).recording).toBeUndefined();
  await expect.poll(pageInset).toEqual({ x: 0, y: 0 });
  await expect
    .poll(async () => (await state()).skills?.map((item) => item.id))
    .toEqual(['e2e-点击']);
  const detail = await shell.evaluate((skillId) => window.pilion.skills.read(skillId), id!);
  expect(detail.steps.map((step) => step.kind)).toEqual(['navigate', 'click']);
  expect(detail.steps[1].text).toMatch(/点击 "Learn more"/);
  expect(detail.markdown).toContain('```json pilion-trajectory');

  // 换一个空标签回放，证明它自己走到了 iana.org，且过程中蒙层（Agent 活动相位）升起。
  await shell.evaluate(() => window.pilion.tabs.open());
  await expect.poll(async () => (await state()).tabs.length).toBe(2);
  await shell.evaluate((skillId) => window.pilion.skills.play(skillId), id!);
  await expect.poll(async () => (await state()).replay?.status).toBe('running');
  await expect.poll(async () => (await state()).replay?.status, { timeout: 60_000 }).toBe('done');
  const after = await state();
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('iana.org');
  expect(after.replay).toMatchObject({ step: 2, total: 2 });

  // 关闭回放条；技能删得掉。
  await shell.evaluate(() => window.pilion.skills.stop());
  await expect.poll(async () => (await state()).replay).toBeUndefined();
  await shell.evaluate((skillId) => window.pilion.skills.remove(skillId), id!);
  await expect.poll(async () => (await state()).skills?.length).toBe(0);
});

test('recording captures scrolling, a back press and a rich-text edit in the process log', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const profile = profileDirectory;
  const state = () => shell.evaluate(() => window.pilion.getState());

  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);

  // 两个「页面」都是 example.com，靠查询串区分成两条不同的历史记录：这台机器上点一个真的
  // 跳到另一个外部域名的链接（比如 example.com 上那个到 iana.org 的链接）会因为外网重定向
  // 慢而偶发假失败，用同一个已经在这份用例里证明可靠的域名，换个查询串就够建立「后退」的历史。
  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com/?pilion-e2e=a'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().includes('pilion-e2e=a')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  // 地址栏导航是第 1 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);

  // 页面本身太短滚不动；垫高再发一次真实的、可信的滚轮事件（isTrusted，不是脚本合成的）。
  await tabPage!.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    document.body.appendChild(spacer);
  });
  await tabPage!.mouse.move(400, 300);
  await tabPage!.mouse.wheel(0, 600);
  // 真实等待三秒以上，好让过程时间线在这里插一行「停顿」。
  await tabPage!.waitForTimeout(3200);

  // 第二次导航建立起「后退」用得上的历史。
  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com/?pilion-e2e=b'));
  await expect.poll(() => tabPage!.url(), { timeout: 30_000 }).toContain('pilion-e2e=b');
  // 第 2 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(2);

  // 后退回第一页：落地地址由下一条 page 事件补上，步骤视图里应该是一条 navigate。
  await shell.evaluate(() => window.pilion.tabs.back());
  await expect.poll(() => tabPage!.url(), { timeout: 30_000 }).toContain('pilion-e2e=a');
  // 第 3 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(3);

  // 富文本：一个 contenteditable，只填一个字符，产出恰好一条「需要我」。
  await tabPage!.evaluate(() => {
    const editor = document.createElement('div');
    editor.id = 'pilion-e2e-editor';
    editor.contentEditable = 'true';
    editor.setAttribute('role', 'textbox');
    editor.style.cssText = 'min-width:200px;min-height:40px;border:1px solid #000;';
    document.body.appendChild(editor);
  });
  await tabPage!.locator('#pilion-e2e-editor').pressSequentially('测');
  // 第 4 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(4);

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 过程'));
  expect(id).toBe('e2e-过程');
  await expect.poll(async () => (await state()).recording).toBeUndefined();

  // 步骤视图：后退是一条 navigate，富文本是一条「需要我」。
  const detail = await shell.evaluate((skillId) => window.pilion.skills.read(skillId), id!);
  expect(detail.steps.map((step) => step.kind)).toEqual([
    'navigate',
    'navigate',
    'navigate',
    'human',
  ]);

  // 录制目录里有 events.jsonl，行数比步骤数多——里面还有 page、scroll 这些不算步骤的条目。
  const eventsText = await readFile(join(profile, 'recordings', id!, 'events.jsonl'), 'utf8');
  const eventLines = eventsText.trim().split('\n');
  expect(eventLines.length).toBeGreaterThan(detail.steps.length);
  // 三条 navigate 的 URL 都含 "example.com"；查询串证明后退真的落回了第一页而不是停在第二页。
  expect(detail.steps[0].text).toContain('pilion-e2e=a');
  expect(detail.steps[1].text).toContain('pilion-e2e=b');
  expect(detail.steps[2].text).toContain('pilion-e2e=a');
  expect(detail.steps[3].text).toContain('需要我');
  expect(detail.steps[3].unsupported).toBe('rich-text');

  // 技能库「过程」视图：滚动折叠成一行，停顿也有一行。
  await shell.getByRole('button', { name: '技能库' }).click();
  await expect(shell.locator('.skills-steps')).toContainText('需要我');
  await shell.getByRole('tab', { name: '过程' }).click();
  await expect(shell.locator('.skills-process')).toContainText(/滚动了 \d+ 次/);
  await expect(shell.locator('.skills-process')).toContainText(/停顿 \d+ 秒/);
});

test('text typed into a rich-text editor never becomes an element name in the log or trajectory', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const profile = profileDirectory;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 一段页面上别处不会出现的字：停止后在日志与轨迹的全文里找它，前后两半各找一次。
  const typed = '机密草稿QX7294';
  const leaking = (text: string) =>
    text.split('\n').filter((line) => line.includes('机密草稿') || line.includes('QX7294'));

  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);

  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com/?pilion-e2e=rich'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().includes('pilion-e2e=rich')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  // 地址栏导航是第 1 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);

  // 一个带角色属性的外壳包着编辑区，像一张有标题、正文可编辑的卡片。页面正文摘录只取最前面的
  // 2000 字，先垫一大段字，让编辑区落在摘录够不到的地方：摘录是另一条口子，这条用例只验元素名。
  // 标题是编辑区之外的字，也就是脚本算出的干净名。旁边另放一个普通按钮，用来证明点卡片时 observe 是活的。
  await tabPage!.evaluate(() => {
    const filler = document.createElement('p');
    filler.textContent = '垫字'.repeat(1200);
    document.body.appendChild(filler);
    const card = document.createElement('div');
    card.setAttribute('role', 'button');
    card.style.cssText = 'display:block;padding:12px;border:1px solid #000;';
    const title = document.createElement('span');
    title.textContent = '草稿卡片';
    card.appendChild(title);
    const editor = document.createElement('div');
    editor.id = 'pilion-e2e-rich';
    editor.contentEditable = 'true';
    editor.style.cssText = 'min-width:200px;min-height:40px;';
    card.appendChild(editor);
    document.body.appendChild(card);
    const plain = document.createElement('button');
    plain.id = 'pilion-e2e-plain';
    plain.textContent = '普通按钮';
    document.body.appendChild(plain);
  });
  const editor = tabPage!.locator('#pilion-e2e-rich');
  // 点进编辑区落在外壳上，是第 2 步；打字只报字数，是第 3 步「需要我」。
  await editor.click();
  await expect.poll(async () => (await state()).recording?.steps).toBe(2);
  await tabPage!.keyboard.insertText(typed);
  await expect.poll(async () => (await state()).recording?.steps).toBe(3);
  await expect(editor).toHaveText(typed);

  // 单页应用边编辑边改地址很常见。地址一变，主进程就重新观察一次页面：这时外壳在可访问性树里
  // 的名字取自内容，正是刚打的字。这条口子只有真实浏览器才有，单测够不到。
  await tabPage!.evaluate(() => {
    location.hash = 'typed';
  });
  await expect
    .poll(async () => {
      const current = await state();
      return current.tabs.find((tab) => tab.id === current.activeTabId)?.url;
    })
    .toContain('#typed');
  // 再点一次编辑区（第 4 步），再点那个普通按钮（第 5 步）：两下用的是同一份新观察。
  await editor.click();
  await expect.poll(async () => (await state()).recording?.steps).toBe(4);
  await tabPage!.locator('#pilion-e2e-plain').click();
  await expect.poll(async () => (await state()).recording?.steps).toBe(5);

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 富文本'));
  expect(id).toBe('e2e-富文本');
  await expect.poll(async () => (await state()).recording).toBeUndefined();

  const dir = join(profile, 'recordings', id!);
  const eventsText = await readFile(join(dir, 'events.jsonl'), 'utf8');
  const trajectoryText = await readFile(join(dir, 'trajectory.md'), 'utf8');
  // 列出带着那段字的行：失败时两个文件各自漏了哪几行、哪个字段，一次都看得到。
  expect.soft(leaking(eventsText)).toEqual([]);
  expect.soft(leaking(trajectoryText)).toEqual([]);

  // 不能空转：字确实打进了编辑区；普通按钮对上了新观察、带着指纹，说明点卡片时 observe 是活的，
  // 可访问性树里那个带着正文的名字就摆在采集层面前，卡片的名字照样被扣下，也不带指纹。
  const events = eventsText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const edits = events.filter((event) => event.kind === 'edit');
  expect(edits.at(-1)).toMatchObject({ length: typed.length });
  const clicks = events.filter((event) => event.kind === 'click');
  expect(clicks).toHaveLength(3);
  expect(clicks[1].el).toEqual({
    tagName: 'div',
    role: 'button',
    name: '草稿卡片',
    editable: true,
  });
  expect(clicks[1].target).toStrictEqual({
    role: 'button',
    name: '',
    tagName: 'div',
    editable: true,
  });
  expect(clicks[2].el).toEqual({ tagName: 'button', role: 'button', name: '普通按钮' });
  expect((clicks[2].target as { fingerprint?: string }).fingerprint).toMatch(/^[a-f0-9]{8}$/);
  const detail = await shell.evaluate((skillId) => window.pilion.skills.read(skillId), id!);
  expect(detail.steps.map((step) => step.kind)).toEqual([
    'navigate',
    'click',
    'human',
    'click',
    'click',
  ]);
  expect(detail.steps[3].text).toBe('点击 [名称已隐去，含富文本]（button）');
});

test('what was typed into fields and an editor never reaches the page excerpt', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const profile = profileDirectory;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 人打的三样东西各取页面上别处不会出现的字。浏览器把密码框的值画成圆点，个数就是密码长度；
  // 页面与轨迹的排版里都没有这个字符，所以一个圆点都不该出现。
  const code = '739514';
  const password = 'Hx7-pass-2291';
  const bullets = '•'.repeat(password.length);
  const sentence = '编辑区里的机密句子RT5528';
  const plain = '普通段落里的可见文字PL3306';
  // 第二个验证码打进 input-otp 那种组件：透明的验证码框盖在六个方框上，每一位由页面画成方框里的普通文字。
  const drawn = '582046';
  const leaking = (text: string) =>
    text
      .split('\n')
      .filter((line) => line.includes(code) || line.includes('•') || line.includes('RT5528'));

  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);

  await shell.evaluate(() =>
    window.pilion.tabs.navigate('https://example.com/?pilion-e2e=excerpt'),
  );
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().includes('pilion-e2e=excerpt')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  // 地址栏导航是第 1 步。
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);

  // 验证码框、密码框、没有角色属性的富文本编辑区，外加一段谁也不能编辑的普通文字。
  await tabPage!.evaluate((text) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    document.body.appendChild(paragraph);
    const field = (label: string, id: string, set: (input: HTMLInputElement) => void) => {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      const input = document.createElement('input');
      input.id = id;
      set(input);
      wrapper.appendChild(input);
      document.body.appendChild(wrapper);
    };
    field('验证码', 'pilion-e2e-otp', (input) =>
      input.setAttribute('autocomplete', 'one-time-code'),
    );
    field('密码', 'pilion-e2e-password', (input) => (input.type = 'password'));
    const editor = document.createElement('div');
    editor.id = 'pilion-e2e-editor';
    editor.contentEditable = 'true';
    editor.style.cssText = 'min-width:200px;min-height:40px;border:1px solid #000;';
    document.body.appendChild(editor);
    // input-otp（shadcn/ui 的 InputOTP、HeroUI 的 InputOtp 都用它）的样子：六个方框，上面整个盖着一个
    // 透明的验证码框，框里每多一位，页面就把它画进对应的方框。
    const widget = document.createElement('div');
    widget.id = 'pilion-e2e-slots';
    widget.style.cssText = 'position:relative;display:inline-flex;gap:4px;';
    const slots = Array.from({ length: 6 }, () => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.cssText = 'width:24px;height:30px;border:1px solid #888;text-align:center;';
      widget.appendChild(slot);
      return slot;
    });
    const cover = document.createElement('div');
    cover.style.cssText = 'position:absolute;inset:0;';
    const hidden = document.createElement('input');
    hidden.id = 'pilion-e2e-drawn';
    hidden.setAttribute('autocomplete', 'one-time-code');
    hidden.maxLength = 6;
    hidden.style.cssText =
      'width:100%;height:100%;color:transparent;caret-color:transparent;background:transparent;border:0;outline:0;';
    hidden.addEventListener('input', () =>
      slots.forEach((slot, index) => (slot.textContent = hidden.value[index] ?? '')),
    );
    cover.appendChild(hidden);
    widget.appendChild(cover);
    document.body.appendChild(widget);
  }, plain);
  const otp = tabPage!.locator('#pilion-e2e-otp');
  const secret = tabPage!.locator('#pilion-e2e-password');
  const editor = tabPage!.locator('#pilion-e2e-editor');
  const hidden = tabPage!.locator('#pilion-e2e-drawn');
  // 两个密级框各是：获得焦点一条「需要我」、点击一步、打字又一条「需要我」，第 2 到第 7 步。
  await otp.click();
  await tabPage!.keyboard.insertText(code);
  await expect.poll(async () => (await state()).recording?.steps).toBe(4);
  await secret.click();
  await tabPage!.keyboard.insertText(password);
  await expect.poll(async () => (await state()).recording?.steps).toBe(7);
  // 点没有角色属性的编辑区是一条「需要我」，打字只报字数，又是一条：第 8、9 步。
  await editor.click();
  await tabPage!.keyboard.insertText(sentence);
  await expect.poll(async () => (await state()).recording?.steps).toBe(9);
  // 画方框的验证码组件与上面的验证码框一样，是第 10 到第 12 步。
  await hidden.click();
  await tabPage!.keyboard.insertText(drawn);
  await expect.poll(async () => (await state()).recording?.steps).toBe(12);
  // 不能空转：四样东西确实在页面上，浏览器此刻的可访问性树里就有它们；验证码的每一位也确实画进了方框。
  await expect(otp).toHaveValue(code);
  await expect(secret).toHaveValue(password);
  await expect(editor).toHaveText(sentence);
  await expect(hidden).toHaveValue(drawn);
  await expect(tabPage!.locator('#pilion-e2e-slots .slot')).toHaveText(drawn.split(''));

  // 单页应用在同一份文档里改地址：主进程记一条新的页面条目，摘录就是这时候从页面上取的。
  await tabPage!.evaluate(() => history.pushState(null, '', '?pilion-e2e=excerpt&moved=1'));
  await expect
    .poll(async () => {
      const current = await state();
      return current.tabs.find((tab) => tab.id === current.activeTabId)?.url;
    })
    .toContain('moved=1');

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 摘录'));
  expect(id).toBe('e2e-摘录');
  await expect.poll(async () => (await state()).recording).toBeUndefined();

  const dir = join(profile, 'recordings', id!);
  const eventsText = await readFile(join(dir, 'events.jsonl'), 'utf8');
  const trajectoryText = await readFile(join(dir, 'trajectory.md'), 'utf8');
  // 列出带着这三样东西的行：失败时两个文件各自漏了哪几行，一次都看得到。
  expect.soft(leaking(eventsText)).toEqual([]);
  expect.soft(leaking(trajectoryText)).toEqual([]);
  expect(eventsText + trajectoryText).not.toContain(bullets);

  // 摘录是活的：改地址之后那条页面条目取在打字之后，普通文字就在里面，轨迹也带着它。
  const events = eventsText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const moved = events.find(
    (event) => event.kind === 'page' && String(event.url).includes('moved=1'),
  );
  expect(moved?.text).toContain(plain);
  expect(trajectoryText).toContain(plain);

  // 画进方框的每一位在摘录里各占一行，上面按行找验证码找不到它们。所以把两个文件里每条页面条目的
  // 摘录拆成行：不许有单独一位数字的行，去掉换行之后也不许拼得出这个验证码。
  const block = trajectoryText.split('```json pilion-trajectory\n')[1].split('\n```')[0];
  const excerpts = {
    'events.jsonl': events.filter((event) => event.kind === 'page').map((event) => event.text),
    'trajectory.md': (JSON.parse(block) as { entries: Record<string, unknown>[] }).entries
      .filter((entry) => entry.kind === 'page')
      .map((entry) => entry.text),
  };
  for (const [file, texts] of Object.entries(excerpts)) {
    const lines = texts.flatMap((text) => String(text).split('\n'));
    const digits = lines.filter((line) => /^\d$/.test(line.trim()));
    const spelled = texts.filter((text) => String(text).replace(/\n/g, '').includes(drawn));
    expect.soft(digits, file).toEqual([]);
    expect.soft(spelled, file).toEqual([]);
    // 不能空转：拆的确实是有普通段落的那几条摘录。
    expect(lines, file).toContain(plain);
  }
});

test('a password revealed with a show-password toggle is never recorded in clear', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const profile = profileDirectory;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 两个密码框各打一段页面上别处不会出现的字：A 先按「显示密码」再去点框打字；B 先打一半，按「显示密码」
  // 看一眼，再点回去打完。
  const first = 'Rv7-first-4418';
  const half = 'Rv7-half-';
  const rest = 'rest-9035';

  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);
  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com/?pilion-e2e=reveal'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().includes('pilion-e2e=reveal')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);

  // 登录框在页面加载、录制脚本开始之后才出现，像单页应用弹出的那种；开关只在点击时换 type。
  await tabPage!.evaluate(() => {
    for (const id of ['a', 'b']) {
      const field = document.createElement('input');
      field.id = `pilion-e2e-reveal-${id}`;
      field.type = 'password';
      const toggle = document.createElement('button');
      toggle.id = `pilion-e2e-reveal-${id}-toggle`;
      toggle.textContent = `显示密码 ${id}`;
      toggle.addEventListener('click', () => {
        field.type = field.type === 'password' ? 'text' : 'password';
      });
      document.body.append(field, toggle);
    }
  });
  const fieldA = tabPage!.locator('#pilion-e2e-reveal-a');
  const fieldB = tabPage!.locator('#pilion-e2e-reveal-b');
  // A：点开关是第 2 步；点框是一条「需要我」和一步点击，打字又一条「需要我」，第 3 到第 5 步。
  await tabPage!.locator('#pilion-e2e-reveal-a-toggle').click();
  await expect(fieldA).toHaveAttribute('type', 'text');
  await fieldA.click();
  await tabPage!.keyboard.insertText(first);
  await expect.poll(async () => (await state()).recording?.steps).toBe(5);
  // B：点框、打前一半是第 6 到第 8 步；点开关第 9 步；点回框、打完第 10 到第 12 步。
  await fieldB.click();
  await tabPage!.keyboard.insertText(half);
  await expect.poll(async () => (await state()).recording?.steps).toBe(8);
  await tabPage!.locator('#pilion-e2e-reveal-b-toggle').click();
  await expect(fieldB).toHaveAttribute('type', 'text');
  await fieldB.click();
  await tabPage!.keyboard.insertText(rest);
  await expect.poll(async () => (await state()).recording?.steps).toBe(12);
  // 不能空转：两个框此刻都是明文框，框里确实是打进去的字。
  await expect(fieldA).toHaveValue(first);
  await expect(fieldB).toHaveValue(half + rest);

  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 显示密码'));
  expect(id).toBe('e2e-显示密码');
  const dir = join(profile, 'recordings', id!);
  for (const file of ['events.jsonl', 'trajectory.md']) {
    const text = await readFile(join(dir, file), 'utf8');
    const leaking = text
      .split('\n')
      .filter((line) => line.includes('Rv7') || line.includes('4418') || line.includes('9035'));
    expect.soft(leaking, file).toEqual([]);
  }
  const detail = await shell.evaluate((skillId) => window.pilion.skills.read(skillId), id!);
  expect(detail.steps.filter((step) => step.text === '需要我：填写密码')).toHaveLength(6);
});

test('replay stops at a step whose target is gone and reports where', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 直接写一份手工轨迹进技能库：第 2 步的按钮在 example.com 上不存在。
  const dir = join(profileDirectory, 'recordings', 'gone');
  await mkdir(dir, { recursive: true });
  const trajectory = {
    meta: { app: 'pilion', version: 1, name: 'gone', recordedAt: '2026-09-20T06:00:00.000Z' },
    entries: [
      {
        kind: 'step',
        at: '2026-09-20T06:00:01.000Z',
        step: { kind: 'navigate', url: 'https://example.com/' },
      },
      {
        kind: 'step',
        at: '2026-09-20T06:00:02.000Z',
        step: {
          kind: 'click',
          onUrl: 'https://example.com/',
          target: { role: 'button', name: '不存在的按钮', tagName: 'button' },
        },
      },
    ],
  };
  await writeFile(
    join(dir, 'trajectory.md'),
    `# gone\n\n\`\`\`json pilion-trajectory\n${JSON.stringify(trajectory, null, 2)}\n\`\`\`\n`,
  );
  // 技能库在启动时读过一次；改名会触发重读，这里用 rename 到同名让主进程刷新列表。
  await shell.evaluate(() => window.pilion.skills.rename('gone', 'gone'));
  await expect
    .poll(async () => (await state()).skills?.some((item) => item.id === 'gone'))
    .toBe(true);

  await shell.evaluate(() => window.pilion.skills.play('gone'));
  await expect.poll(async () => (await state()).replay?.status, { timeout: 60_000 }).toBe('failed');
  const after = await state();
  expect(after.replay?.message).toMatch(/第 2 步失败（NO_MATCH）：点击 "不存在的按钮"/);
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('example.com');
});

test('a hand-edited trajectory keeps reporting the recompute notice until its detail is opened', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const profile = profileDirectory;
  const state = () => shell.evaluate(() => window.pilion.getState());

  // 录一份带过程记录的最小录制：只导航一次，不用再点穿到外部域名——后面只需要一份
  // events.jsonl 齐全、哈希对得上的录制拿来手改。
  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);
  await shell.evaluate(() =>
    window.pilion.tabs.navigate('https://example.com/?pilion-e2e=recompute'),
  );
  let tabPage: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          if (page.url().includes('pilion-e2e=recompute')) {
            tabPage = page;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);
  const id = await shell.evaluate(() => window.pilion.recording.stop('e2e 重算提示'));
  expect(id).toBe('e2e-重算提示');
  await expect.poll(async () => (await state()).recording).toBeUndefined();

  // 手改这份录制的 trajectory.md：清空步骤，不碰 meta 里的两个哈希——这是人在编辑器里
  // 删一段最常见的样子，日志哈希单独查不出这种改动（见 recording-library.test.ts 里同一种
  // 手改方式）。
  const dir = join(profile, 'recordings', id!);
  const before = await readFile(join(dir, 'trajectory.md'), 'utf8');
  const match = /```json pilion-trajectory\n([\s\S]+?)\n```/.exec(before);
  if (!match) throw new Error('trajectory.md 里找不到 json 块');
  const tampered = JSON.parse(match[1]) as { entries: unknown[] };
  tampered.entries = [];
  await writeFile(
    join(dir, 'trajectory.md'),
    before.replace(match[1], JSON.stringify(tampered, null, 2)),
  );

  // 另建一份录制并改它的名字，触发一次列表刷新——这一刻没人点开过手改的那份，
  // 提示不该被这次刷新吃掉。recordedAt 特意排到手改的那份前面：技能库打开时默认选中
  // 列表第一行，不能让这一步顺带把还没点开过的那份也算成看过了。
  const otherDir = join(profile, 'recordings', 'other');
  await mkdir(otherDir, { recursive: true });
  await writeFile(
    join(otherDir, 'trajectory.md'),
    `# other\n\n\`\`\`json pilion-trajectory\n${JSON.stringify(
      {
        meta: { app: 'pilion', version: 1, name: 'other', recordedAt: '2099-01-01T00:00:00.000Z' },
        entries: [
          {
            kind: 'step',
            at: '2026-09-20T06:00:01.000Z',
            step: { kind: 'navigate', url: 'https://example.com/' },
          },
        ],
      },
      null,
      2,
    )}\n\`\`\`\n`,
  );
  await shell.evaluate(() => window.pilion.skills.rename('other', 'other'));
  await expect
    .poll(async () => (await state()).skills?.find((item) => item.id === id)?.recomputed)
    .toBe(true);

  // 技能库列表这一行已经带着短标记；点开它才看到那句完整的话。
  await shell.getByRole('button', { name: '技能库' }).click();
  const row = shell.getByRole('listitem').filter({ hasText: 'e2e 重算提示' });
  await expect(row).toContainText('步骤已重算');
  await row.click();
  await expect(shell.locator('.skills-detail')).toContainText(
    '步骤已按过程记录重算，手工改动未保留。',
  );

  // 列表的短标记应声消失；看过的那句话来自这次详情响应，不会跟着列表刷新一起消失。
  await expect(row).not.toContainText('步骤已重算');
  await expect(shell.locator('.skills-detail')).toContainText(
    '步骤已按过程记录重算，手工改动未保留。',
  );

  // 关掉再点开：不再出现。先等到这份录制自己的步骤真的渲染出来——不然「不包含那句话」
  // 在换行之后、新详情还没读回来之前的一瞬间也是真的，不能说明问题；只有等内容确实落到
  // 这份录制身上，再看那句话是不是也跟着回来了，才是这条用例真正要钉住的时刻。
  await shell.getByRole('listitem').filter({ hasText: 'other' }).click();
  await row.click();
  await expect(shell.locator('.skills-detail')).toContainText('pilion-e2e=recompute');
  await expect(shell.locator('.skills-detail')).not.toContainText(
    '步骤已按过程记录重算，手工改动未保留。',
  );
});

/** 第二期的用例都连同一个 fixture Agent。 */
async function connectFixtureAgent(shell: Page, id: string): Promise<void> {
  await shell.evaluate((config) => window.pilion.agents.save(config), {
    id,
    name: id,
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await shell.evaluate((agentId) => window.pilion.agents.connect(agentId), id);
  await expect
    .poll(() => shell.evaluate(() => window.pilion.getState().then((state) => state.agentStatus)))
    .toBe('ready');
}

/**
 * 让标签页停在一个真实页面再起播：审批绑的就是这一刻的 origin。
 * 与在空白标签上起播的第一个用例互为两面，两条 origin 分支都有人走。
 */
async function settleOnExample(shell: Page): Promise<void> {
  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await expect
    .poll(async () => {
      const current = await shell.evaluate(() => window.pilion.getState());
      const tab = current.tabs.find((item) => item.id === current.activeTabId);
      return { url: tab?.url ?? '', loading: tab?.loading };
    })
    .toEqual({ url: 'https://example.com/', loading: false });
}

const HAND_WRITTEN_AT = '2026-09-20T06:00:00.000Z';

/**
 * 人手写一份已提炼的技能：轨迹与 skill.md 一起落进 profile，和人自己改过文件一样。
 * 技能库启动时读过一次，写完要 rename 到同名才会重读。
 */
async function writeKeptSkill(
  profile: string,
  id: string,
  about: string,
  steps: Record<string, unknown>[],
): Promise<void> {
  const directory = join(profile, 'recordings', id);
  await mkdir(directory, { recursive: true });
  const trajectory = {
    meta: { app: 'pilion', version: 1, name: id, recordedAt: HAND_WRITTEN_AT },
    // 轨迹是技能的出处；只有动作步骤才可能来自录制，human 是提炼时插进去的。
    entries: steps
      .filter((step) => step.kind !== 'human' && step.kind !== 'note')
      .map((step) => ({ kind: 'step', at: HAND_WRITTEN_AT, step })),
  };
  await writeFile(
    join(directory, 'trajectory.md'),
    `# ${id}\n\n\`\`\`json pilion-trajectory\n${JSON.stringify(trajectory, null, 2)}\n\`\`\`\n`,
  );
  const skill = {
    meta: {
      app: 'pilion',
      version: 1,
      kind: 'skill',
      name: id,
      about,
      recordedAt: HAND_WRITTEN_AT,
      distilledBy: 'person',
      trajectory: 'trajectory.md',
    },
    steps,
  };
  await writeFile(
    join(directory, 'skill.md'),
    `# ${id}\n\n${about}\n\n\`\`\`json pilion-skill\n${JSON.stringify(skill, null, 2)}\n\`\`\`\n`,
  );
}

test('the Agent distils a recording, the person keeps it, and the Agent replays it after one approval', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  const shell = mainPage;
  const app = application;
  const state = () => shell.evaluate(() => window.pilion.getState());
  await connectFixtureAgent(shell, 'distil-agent');

  // 人录两步：地址栏导航是第 1 步，页面上的真实点击是第 2 步。
  await shell.evaluate(() => window.pilion.recording.start());
  await expect.poll(async () => Boolean((await state()).recording)).toBe(true);
  await shell.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  let tabPage: Page | undefined;
  await expect
    .poll(
      () => {
        for (const page of app.windows())
          if (page.url().startsWith('https://example.com')) {
            tabPage = page;
            return true;
          }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await tabPage!.waitForLoadState('domcontentloaded');
  await expect.poll(async () => (await state()).recording?.steps).toBe(1);
  await tabPage!.click('a');
  await expect.poll(() => tabPage!.url(), { timeout: 30_000 }).toContain('iana.org');
  await expect.poll(async () => (await state()).recording?.steps).toBe(2);
  expect(await shell.evaluate(() => window.pilion.recording.stop('e2e 技能'))).toBe('e2e-技能');

  // Agent 在专属对话里提炼一次；主进程逐步对账后才把提案交给人看。
  await shell.evaluate(() => window.pilion.skills.distill('e2e-技能'));
  await expect
    .poll(async () => (await state()).distillation?.status, { timeout: 60_000 })
    .toBe('proposed');
  const proposal = (await state()).distillation!;
  expect(proposal.steps?.map((step) => step.kind)).toEqual(['navigate', 'click']);
  expect(proposal.markdown).toContain('```json pilion-skill');
  await shell.evaluate(() => window.pilion.skills.keep());
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'e2e-技能')?.distilled)
    .toBe(true);

  // 换一个空标签让 Agent 自己发现并回放：技能的第一步自己会导航，人不用先开好页面。
  await shell.evaluate(() => window.pilion.tabs.open());
  await expect.poll(async () => (await state()).tabs.length).toBe(2);
  await expect
    .poll(async () => {
      const current = await state();
      return current.tabs.find((tab) => tab.id === current.activeTabId)?.url;
    })
    .toBe('about:blank');
  // full 模式下首次回放也要人批一次，审批要绑得住空白页。
  const turn = shell.evaluate(() => window.pilion.agents.task('用技能打开说明页'));
  await expect.poll(async () => (await state()).approvals.length).toBe(1);
  const approval = (await state()).approvals[0];
  expect(approval.tool).toBe('browser.skills.play');
  expect(approval.summary).toContain('回放技能「e2e 技能」');
  expect(approval.summary).toContain('1. 打开 https://example.com/');
  await shell.evaluate(
    (item) =>
      window.pilion.agents.approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve'),
    approval,
  );
  await turn;
  const after = await state();
  expect(after.approvals).toHaveLength(0);
  const last = after.conversations
    ?.find((item) => item.id === after.activeConversationId)
    ?.messages.at(-1);
  expect(last?.text).toContain('"ok":true');
  // 最后一步的点击把页面带去了说明页；跳转可能比回合结束晚一点落地。
  await expect
    .poll(
      async () => {
        const current = await state();
        return current.tabs.find((tab) => tab.id === current.activeTabId)?.url;
      },
      { timeout: 30_000 },
    )
    .toContain('iana.org');
});

test('a replayed skill whose target is gone reports the failed step back to the Agent', async () => {
  if (!mainPage || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  // 手写一份已提炼的技能：第 2 步的按钮在 example.com 上不存在。
  await writeKeptSkill(profileDirectory, 'gone', '目标不存在', [
    { kind: 'navigate', url: 'https://example.com/' },
    {
      kind: 'click',
      onUrl: 'https://example.com/',
      target: { role: 'button', name: '不存在的按钮', tagName: 'button' },
    },
  ]);
  await shell.evaluate(() => window.pilion.skills.rename('gone', 'gone'));
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'gone')?.distilled)
    .toBe(true);

  // 这一份技能自己会先导航，所以也从初始的空白标签起播。
  await connectFixtureAgent(shell, 'gone-agent');
  const turn = shell.evaluate(() => window.pilion.agents.task('用技能'));
  await expect.poll(async () => (await state()).approvals.length).toBe(1);
  const approval = (await state()).approvals[0];
  expect(approval.tool).toBe('browser.skills.play');
  await shell.evaluate(
    (item) =>
      window.pilion.agents.approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve'),
    approval,
  );
  await turn;
  const after = await state();
  const last = after.conversations
    ?.find((item) => item.id === after.activeConversationId)
    ?.messages.at(-1);
  // 失败现场回到 Agent 手里：停在第几步、还剩哪些步骤。
  expect(last?.text).toContain('"failedAt":2');
  expect(last?.text).toContain('"remaining"');
  expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.url).toContain('example.com');
});

test('a skill that needs the person hands the browser back and resumes from the next step', async () => {
  if (!mainPage || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  const conversation = async () => {
    const current = await state();
    return current.conversations?.find((item) => item.id === current.activeConversationId);
  };
  const lastText = async () => (await conversation())?.messages.at(-1)?.text;
  // 第 2 步是人做的，第 3 步还在 example.com 上，所以续播接得住。
  await writeKeptSkill(profileDirectory, 'captcha', '中间要人填验证码', [
    { kind: 'navigate', url: 'https://example.com/' },
    { kind: 'human', onUrl: 'https://example.com/', reason: '填写验证码' },
    {
      kind: 'click',
      onUrl: 'https://example.com/',
      target: { role: 'link', name: 'Learn more', tagName: 'a' },
    },
  ]);
  await shell.evaluate(() => window.pilion.skills.rename('captcha', 'captcha'));
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'captcha')?.needsHuman)
    .toBe(1);

  await connectFixtureAgent(shell, 'captcha-agent');
  await settleOnExample(shell);
  const first = shell.evaluate(() => window.pilion.agents.task('用技能'));
  await expect.poll(async () => (await state()).approvals.length).toBe(1);
  const approval = (await state()).approvals[0];
  // 审批摊开全部步骤，人做的那一步也在里面。
  expect(approval.summary).toContain('2. 需要我：填写验证码');
  await shell.evaluate(
    (item) =>
      window.pilion.agents.approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve'),
    approval,
  );
  await first;
  expect(await lastText()).toContain('"reason":"HUMAN"');
  const paused = await conversation();
  expect(paused?.task?.status).toBe('manual');
  expect(paused?.task?.replayCursor).toMatchObject({ skillId: 'captcha', nextStep: 3 });

  // 人按继续：交接说明里写明从第 3 步续播。这一轮跑完本身就说明没有再问第二次审批。
  await shell.evaluate(() => window.pilion.agents.resume());
  expect(await lastText()).toContain('"ok":true');
  const after = await state();
  expect(after.approvals).toHaveLength(0);
  expect(after.agentStatus).toBe('ready');
  // 第 3 步的点击把页面带去了说明页；跳转可能比回合结束晚一点落地。
  await expect
    .poll(
      async () => {
        const current = await state();
        return current.tabs.find((tab) => tab.id === current.activeTabId)?.url;
      },
      { timeout: 30_000 },
    )
    .toContain('iana.org');
});

test('editing a kept skill changes what the Agent replays and asks the person again', async () => {
  if (!mainPage || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  await writeKeptSkill(profileDirectory, 'editable', '打开示例站点并点进说明页', [
    { kind: 'navigate', url: 'https://example.com/' },
    {
      kind: 'click',
      onUrl: 'https://example.com/',
      target: { role: 'link', name: 'Learn more', tagName: 'a' },
    },
  ]);
  await shell.evaluate(() => window.pilion.skills.rename('editable', 'editable'));
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'editable')?.distilled)
    .toBe(true);

  // 人只能删、排、改值、插「需要我」：这里删掉点击，换成一条人来做的步骤。
  const before = await shell.evaluate(() => window.pilion.skills.read('editable'));
  expect(before.steps.map((step) => step.kind)).toEqual(['navigate', 'click']);
  const steps: Record<string, unknown>[] = [
    before.steps[0].raw,
    { kind: 'human', onUrl: 'https://example.com/', reason: '检查一下' },
  ];
  await shell.evaluate((input) => window.pilion.skills.save(input.id, input.prose, input.steps), {
    id: 'editable',
    prose: before.prose ?? '',
    steps,
  });
  const edited = await shell.evaluate(() => window.pilion.skills.read('editable'));
  expect(edited.steps.map((step) => step.kind)).toEqual(['navigate', 'human']);
  expect(edited.steps[1].text).toBe('需要我：检查一下');

  // 文件变了哈希就变了：Agent 再播还要人再批一次，批的是改过的那几步。
  await connectFixtureAgent(shell, 'editable-agent');
  await settleOnExample(shell);
  const turn = shell.evaluate(() => window.pilion.agents.task('用技能'));
  await expect.poll(async () => (await state()).approvals.length).toBe(1);
  const approval = (await state()).approvals[0];
  expect(approval.tool).toBe('browser.skills.play');
  expect(approval.summary).toContain('2. 需要我：检查一下');
  expect(approval.summary).not.toContain('Learn more');
  await shell.evaluate(
    (item) =>
      window.pilion.agents.approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve'),
    approval,
  );
  await turn;
  const after = await state();
  const last = after.conversations
    ?.find((item) => item.id === after.activeConversationId)
    ?.messages.at(-1);
  expect(last?.text).toContain('"reason":"HUMAN"');
});

test('saving an edit through the skill library interface refreshes the pane it was saved from', async () => {
  if (!mainPage || !profileDirectory) throw new Error('Not launched');
  const shell = mainPage;
  const state = () => shell.evaluate(() => window.pilion.getState());
  await writeKeptSkill(profileDirectory, 'prose-edit', '改之前的说明', [
    { kind: 'navigate', url: 'https://example.com/' },
    {
      kind: 'click',
      onUrl: 'https://example.com/',
      target: { role: 'link', name: 'Learn more', tagName: 'a' },
    },
  ]);
  await shell.evaluate(() => window.pilion.skills.rename('prose-edit', 'prose-edit'));
  await expect
    .poll(async () => (await state()).skills?.find((row) => row.id === 'prose-edit')?.distilled)
    .toBe(true);

  // 全程走界面：开技能库、点这一行、进编辑、改说明、保存——不直接调 skills.save。
  await shell.getByRole('button', { name: '技能库' }).click();
  await shell.getByRole('listitem').filter({ hasText: 'prose-edit' }).click();
  await shell.getByRole('button', { name: '编辑' }).click();
  const prose = shell.getByLabel('技能说明');
  await expect(prose).toHaveValue(/改之前的说明/);
  await prose.fill('# prose-edit\n\n改之后的说明，测试详情有没有跟着刷新');
  await shell.getByRole('button', { name: '保存' }).click();
  // 保存成功会退出编辑态，「编辑」按钮重新出现，是保存这一步已经走完的信号。
  await expect(shell.getByRole('button', { name: '编辑' })).toBeVisible();

  // 详情面板要跟着刷新，不能只是文件改了、界面还拿着保存前读到的那份缓存：重新点进编辑器，
  // 看到的应该是刚保存的新说明，而不是打开这份技能那一刻缓存下来、早已经过时的旧说明。
  await shell.getByRole('button', { name: '编辑' }).click();
  await expect(shell.getByLabel('技能说明')).toHaveValue(/改之后的说明，测试详情有没有跟着刷新/);
});
