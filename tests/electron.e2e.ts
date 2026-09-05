import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');

let application: ElectronApplication | undefined;
let profileDirectory: string | undefined;
let mainPage: Page | undefined;

test.beforeAll(async () => {
  profileDirectory = await mkdtemp(join(tmpdir(), 'pilion-e2e-'));
  application = await electron.launch({
    args: [projectRoot, `--user-data-dir=${profileDirectory}`, '--no-first-run'],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 30_000,
  });
  mainPage = await application.firstWindow();
  await mainPage.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  if (application) {
    for (const page of application.windows()) {
      if (page !== mainPage) await page.close().catch(() => undefined);
    }
    await application.close().catch(() => application?.process().kill('SIGKILL'));
    application = undefined;
  }
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
});

test('built Electron MVP enforces its integration boundary', async () => {
  if (!application || !mainPage) throw new Error('Electron application did not launch');

  await expect(mainPage).toHaveTitle('Pilion Browser');
  await expect(mainPage.getByRole('heading', { name: 'Pilion Agent' })).toBeVisible();
  await expect(mainPage.getByLabel('Pilion AI 工作区')).toBeVisible();
  await mainPage.screenshot({ path: join(projectRoot, 'test-results', 'pilion-browser-renderer.png') });

  await expect.poll(async () => {
    const state = await mainPage!.evaluate(() => window.pilion.getState());
    return { tabs: state.tabs.length, active: Boolean(state.activeTabId) };
  }).toEqual({ tabs: 1, active: true });

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
    root: ['agents', 'getState', 'onState', 'tabs'],
    tabs: ['activate', 'back', 'close', 'forward', 'navigate', 'open', 'reload'],
    agents: ['attach', 'cancel', 'connect', 'detach', 'disconnect', 'save', 'task'],
    clipboard: false,
  });

  const config = {
    id: 'playwright-agent', name: 'Playwright Spike Agent', command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')], cwd: projectRoot, enabled: true,
  };
  await mainPage.evaluate(agent => window.pilion.agents.save(agent), config);
  await mainPage.locator('select').selectOption(config.id);
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

  await mainPage.getByPlaceholder('输入任务').fill('触发一次受控点击审批');
  await mainPage.getByRole('button', { name: '发送' }).click();
  await expect.poll(async () => (await Promise.all(application!.windows().map(page => page.title()))).includes('Pilion 安全审批'), { timeout: 15_000 }).toBe(true);
  const approvalWindow = application.windows().find(page => page !== mainPage && page.url().includes('approval.html'));
  if (!approvalWindow) throw new Error('Approval window was not created');
  await approvalWindow.waitForLoadState('domcontentloaded');
  await expect(approvalWindow).toHaveTitle('Pilion 安全审批');
  await expect(approvalWindow.getByRole('button', { name: '批准一次' })).toBeVisible();
  await expect(approvalWindow.locator('#approval-summary')).toContainText('来源：可信页面快照');
  await expect(approvalWindow.locator('#approval-summary')).not.toContainText('elementRef');
  const approvalSecurity = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(item => ({
    url: item.webContents.getURL(), preferences: (item.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences(),
  })));
  const approval = approvalSecurity.find(item => item.url === pathToFileURL(join(projectRoot, 'src/preload/approval.html')).href);
  expect(approval).toBeDefined();
  expect(approval?.preferences.sandbox).toBe(true);
  expect(approval?.preferences.contextIsolation).toBe(true);

  await mainPage.evaluate(() => window.pilion.tabs.navigate('https://example.org'));
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.approvals.length))).toBe(0);
  await expect.poll(() => mainPage!.evaluate(() => window.pilion.getState().then(state => state.agentStatus))).toBe('ready');
});
