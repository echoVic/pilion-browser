import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm, readFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');

let application: ElectronApplication | undefined;
let profileDirectory: string | undefined;
let mainPage: Page | undefined;

test.beforeEach(async () => {
  profileDirectory = await mkdtemp(join(tmpdir(), 'pilion-e2e-'));
  const bin = join(profileDirectory, 'bin'); await mkdir(bin);
  const presetAgent = join(bin, 'fixture-agent.mjs');
  await writeFile(presetAgent, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(join(projectRoot, 'tests/fixtures/e2e-agent.mjs')).href)};\n`, { mode: 0o755 });
  await symlink(presetAgent, join(bin, 'claude-agent-acp'));
  application = await electron.launch({
    args: [projectRoot, `--user-data-dir=${profileDirectory}`, '--no-first-run'],
    cwd: projectRoot,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_ENV: 'test' },
    timeout: 30_000,
  });
  mainPage = await application.firstWindow();
  await mainPage.waitForLoadState('domcontentloaded');
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.tabs.length))).toBe(1);
});

test('workspace browsing, streamed conversation, cancellation and restore', async () => {
  if (!mainPage || !application || !profileDirectory) throw new Error('Not launched');
  const errors: string[] = [];
  mainPage.on('pageerror', error => errors.push(error.message));
  const config = { id: 'workspace-agent', name: 'Workspace ACP Agent', command: process.execPath, args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')], cwd: projectRoot, enabled: true };
  await mainPage.evaluate(agent => window.pilion.agents.save(agent), config);
  await mainPage.getByLabel('选择 Agent').selectOption(config.id);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.bookmarks?.length))).toBe(1);
  await mainPage.getByRole('button', { name: '书签', exact: true }).click();
  await expect(mainPage.getByRole('heading', { name: '书签' })).toBeVisible();
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.every(view => !view.getVisible()))).toBe(true);
  await mainPage.getByRole('button', { name: '浏览器', exact: false }).first().click();
  await mainPage.getByLabel('输入任务').fill('总结页面');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('Example Domain');
  await expect(mainPage.locator('.message.assistant').last().getByRole('heading', { name: '页面摘要' })).toBeVisible();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
  const conversation = await mainPage.evaluate(() => window.pilion.getState().then(state => state.conversations?.find(item => item.id === state.activeConversationId)));
  expect(conversation?.messages.filter(item => item.role === 'assistant' && item.text.includes('页面摘要'))).toHaveLength(1);
  await mainPage.getByRole('button', { name: '复制回复' }).last().click();
  expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain('Example Domain');
  await mainPage.getByLabel('输入任务').fill('等待取消');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.getByRole('button', { name: '停止任务' })).toBeVisible();
  const duplicate = await mainPage.evaluate(() => window.pilion.agents.task('duplicate').then(() => 'accepted', error => String(error)));
  expect(duplicate).toContain('请等待当前任务结束');
  await mainPage.getByRole('button', { name: '停止任务' }).click();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
  await mainPage.getByRole('button', { name: '新对话', exact: true }).click();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.activeConversationId))).not.toBe(conversation?.id);
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
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 720));
  await expect(mainPage.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
  await mainPage.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(mainPage.getByRole('button', { name: 'Agent 连接', exact: false }).first()).toBeVisible();
  await mainPage.getByRole('button', { name: '收起侧边栏' }).click();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-narrow.png') });
  expect(await mainPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
  await mainPage.getByRole('button', { name: '主题：跟随系统' }).click();
  await mainPage.getByRole('button', { name: '主题：浅色' }).click();
  await expect(mainPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-dark.png') });
  expect(errors).toEqual([]);
  await application.close(); application = undefined;
  const saved = JSON.parse(await readFile(join(profileDirectory, 'workspace.json'), 'utf8'));
  expect(saved.conversations.some((item: { messages: { text: string }[] }) => item.messages.some(message => message.text.includes('页面摘要')))).toBe(true);
  expect(saved.bookmarks).toHaveLength(1);
  application = await electron.launch({ args: [projectRoot, `--user-data-dir=${profileDirectory}`], cwd: projectRoot, env: { ...process.env, NODE_ENV: 'test' } });
  mainPage = await application.firstWindow();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.tabs.length))).toBe(saved.tabs.length);
  expect(await mainPage.evaluate(() => window.pilion.getState().then(state => state.bookmarks?.length))).toBe(1);
});

test.afterEach(async () => {
  if (application) {
    for (const page of application.windows()) {
      if (page !== mainPage) await page.close().catch(() => undefined);
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
  await expect(mainPage.getByLabel('本地 Agent', { exact: true }).locator('option')).toHaveText(['Claude Code', 'Codex', 'Gemini CLI', 'Grok Build', 'OpenCode', 'Pi']);
  for (const preset of ['grok', 'opencode', 'pi']) {
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
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.connectedAgentId))).toBe('local:claude');
  await expect(mainPage.getByRole('heading', { name: '新标签页' })).toBeVisible();
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByLabel('输入任务').fill('总结页面');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant')).toContainText('Example Domain');
  const config = await mainPage.evaluate(() => window.pilion.getState().then(state => state.agents.find(agent => agent.id === 'local:claude')));
  expect(config?.preset).toBe('claude'); expect(config?.cwd).toContain('workspace-files');
});

test('built Electron MVP enforces its integration boundary', async () => {
  if (!application || !mainPage) throw new Error('Electron application did not launch');

  await expect(mainPage).toHaveTitle('Pilion Browser');
  await expect(mainPage.getByRole('heading', { name: 'Agent' })).toBeVisible();
  await expect(mainPage.getByLabel('Pilion AI 工作区')).toBeVisible();
  await expect.poll(async () => {
    const state = await mainPage!.evaluate(() => window.pilion.getState());
    return { tabs: state.tabs.length, active: Boolean(state.activeTabId) };
  }).toEqual({ tabs: 1, active: true });

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
  expect(visualStructure.chromeHeight).toBe(52);
  expect(visualStructure.panelWidth).toBe(368);
  expect(visualStructure.omniboxRadius).toBe(7);
  expect(visualStructure.omniboxBackground).not.toBe('rgba(0, 0, 0, 0)');

  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-browser-renderer.png') });

  await mainPage.getByLabel('地址栏').fill('https://example.com');
  await mainPage.getByLabel('地址栏').press('Enter');
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.tabs[0]?.url))).toBe('https://example.com/');

  const security = await application.evaluate(({ BrowserWindow, webContents }) => ({
    windows: BrowserWindow.getAllWindows().map(item => ({
      url: item.webContents.getURL(),
      preferences: (item.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences(),
    })),
    contents: webContents.getAllWebContents().map(item => ({
      url: item.getURL(), type: item.getType(), preferences: (item as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences(),
    })),
  }));
  const shell = security.windows.find(item => item.url.includes('dist-renderer/index.html'));
  expect(shell).toBeDefined();
  expect(shell?.preferences.sandbox).toBe(true);
  expect(shell?.preferences.contextIsolation).toBe(true);
  expect(shell?.preferences.nodeIntegration).toBe(false);

  const untrustedPage = security.contents.find(item => /^https:\/\//.test(item.url));
  expect(untrustedPage).toBeDefined();
  expect(untrustedPage?.preferences.sandbox).toBe(true);
  expect(untrustedPage?.preferences.contextIsolation).toBe(true);
  expect(untrustedPage?.preferences.nodeIntegration).toBe(false);
  expect(untrustedPage?.preferences.preload).toBeUndefined();

  const preloadSurface = await mainPage.evaluate(() => ({
    root: Object.keys(window.pilion).sort(),
    tabs: Object.keys(window.pilion.tabs).sort(),
    agents: Object.keys(window.pilion.agents).sort(),
    clipboard: 'clipboard' in window.pilion,
  }));
  expect(preloadSurface).toEqual({
    root: ['agents', 'getState', 'onShortcut', 'onState', 'tabs', 'viewport', 'workspace'],
    tabs: ['activate', 'back', 'close', 'forward', 'navigate', 'open', 'reload'],
    agents: ['approve', 'attach', 'cancel', 'chooseDirectory', 'configureLocal', 'connect', 'detach', 'disconnect', 'inspectLocal', 'remove', 'save', 'setMode', 'setModel', 'task'],
    clipboard: false,
  });

  const config = {
    id: 'playwright-agent', name: 'Playwright ACP Agent', command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')], cwd: projectRoot, enabled: true,
  };
  await mainPage.evaluate(agent => window.pilion.agents.save(agent), config);
  await mainPage.getByLabel('选择 Agent').selectOption(config.id);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.attachmentStatus))).toBe('attached');

  const detach = mainPage.getByRole('button', { name: 'Detach' });
  const attach = mainPage.getByRole('button', { name: 'Attach' });
  await expect(detach).toBeEnabled();
  await detach.click();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.attachmentStatus))).toBe('detached');
  await expect(attach).toBeEnabled();
  await attach.click();
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.attachmentStatus))).toBe('attached');

  await mainPage.getByLabel('权限类型').selectOption('ask');
  await expect(mainPage.getByLabel('权限类型')).toHaveValue('ask');
  await mainPage.getByPlaceholder('输入任务').fill('触发一次受控点击审批');
  await mainPage.getByRole('button', { name: '发送' }).click();
  await expect(mainPage.getByRole('region', { name: '操作审批' })).toBeVisible();
  await expect(mainPage.getByRole('button', { name: '批准一次' })).toBeInViewport();
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await mainPage.locator('.inline-approval summary').click();
  await expect(mainPage.locator('.inline-approval pre')).toContainText('来源：可信页面快照');
  await expect(mainPage.locator('.inline-approval pre')).not.toContainText('elementRef');
  const stale = await mainPage.evaluate(() => window.pilion.getState().then(state => state.approvals[0]));

  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.org'));
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.approvals.length))).toBe(0);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
  const replay = await mainPage.evaluate(item => window.pilion.agents.approve(item.approvalId, item.nonce!, item.actionDigest!, 'approve').then(() => 'accepted', error => String(error)), stale);
  expect(replay).toContain('审批已结束');
});

test('composer controls apply permission and model, with approvals pinned in the Agent panel', async () => {
  if (!mainPage || !application) throw new Error('Not launched');
  await mainPage.evaluate(agent => window.pilion.agents.save(agent), { id: 'controls-agent', name: 'Controls Agent', command: process.execPath, args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')], cwd: projectRoot, enabled: true });
  await mainPage.getByLabel('选择 Agent').selectOption('controls-agent');
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
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
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 640));
  await mainPage.locator('.inline-approval summary').click();
  await expect(mainPage.getByRole('button', { name: '批准一次' })).toBeInViewport();
  await expect(mainPage.getByRole('button', { name: '拒绝', exact: true })).toBeInViewport();
  await expect(mainPage.getByLabel('模型')).toBeInViewport();
  await expect(mainPage.getByLabel('权限类型')).toBeInViewport();
  await expect(mainPage.getByRole('button', { name: '停止任务' })).toBeInViewport({ ratio: 1 });
  const geometry = await mainPage.evaluate(() => ({ height: innerHeight, elements: [...document.querySelector('.ai-workspace')!.children].map(element => ({ className: element.className, top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom, height: element.getBoundingClientRect().height })) }));
  expect(geometry.elements.at(-1)!.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height);
  expect(await mainPage.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-inline-approval.png') });
  await mainPage.getByRole('button', { name: '批准一次' }).click();
  await expect(mainPage.locator('.inline-approval')).toHaveCount(0);
  await expect(mainPage.locator('.message.assistant').last()).toContainText('"mode":"default"');
  await mainPage.getByLabel('输入任务').fill('ACP 审批');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await mainPage.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('reject-once');
  await mainPage.getByLabel('权限类型').selectOption('full');
  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.com'));
  await mainPage.getByLabel('输入任务').fill('浏览器自动批准');
  await mainPage.getByRole('button', { name: '发送', exact: true }).click();
  await expect(mainPage.locator('.message.assistant').last()).toContainText('Browser click completed');
  await expect(mainPage.locator('.inline-approval')).toHaveCount(0);
});
