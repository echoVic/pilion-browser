const repo = process.env.PILION_QA_REPO || process.cwd();
const { _electron, expect } = require(require.resolve('@playwright/test', { paths: [repo] }));
const { mkdir, readFile, writeFile, mkdtemp } = require('node:fs/promises');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const crx = process.env.PILION_QA_TAMPERMONKEY_CRX || join(__dirname, 'tampermonkey-5.5.1.crx');
const originalHash = 'b5167937817e636adeba462ed9bf9b32ff01c2888f78a9afc6aa4f8e655fe872';
const python = process.platform === 'win32' ? 'python' : 'python3';
const executablePath = process.env.PILION_NATIVE_QA_EXECUTABLE;
if (!executablePath) throw Error('Missing extracted native Electron path');
const server = createServer((_, res) => res.end('<!doctype html><title>Pilion QA</title><p>Local test page</p>'));
const find = async (app, expected) => {
  let page;
  try {
    await expect.poll(() => Boolean(page = app.windows().find(p => expected(p.url()))), { timeout: 120000 }).toBe(true);
  } catch (error) {
    console.log('diagnostic: windows', app.windows().map(p => p.url()));
    console.log('diagnostic: process exit code', app.process().exitCode, 'signal', app.process().signalCode);
    throw error;
  }
  return page;
};
(async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'pilion-tampermonkey-'));
  const profile = join(runDir, 'profile');
  const home = join(runDir, 'home');
  const localAppData = join(home, 'AppData', 'Local');
  const chrome = {
    darwin: join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
    win32: join(localAppData, 'Google', 'Chrome', 'User Data'),
    linux: join(home, '.config', 'google-chrome'),
  }[process.platform];
  if (!chrome) throw new Error(`Unsupported platform: ${process.platform}`);
  const extDir = join(chrome, 'Default/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/5.5.1_0');
  await mkdir(extDir, { recursive: true });
  await mkdir(join(runDir, 'integration'));
  const publisherPackage = await readFile(crx);
  if (createHash('sha256').update(publisherPackage).digest('hex') !== originalHash)
    throw Error('Tampermonkey 5.5.1 publisher package SHA-256 does not match');
  execFileSync(python, ['-c', `
import pathlib, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    for entry in archive.infolist():
        path = pathlib.PurePosixPath(entry.filename)
        if path.is_absolute() or '..' in path.parts or chr(92) in entry.filename or ':' in entry.filename:
            raise ValueError('Unsafe extension archive path')
    archive.extractall(sys.argv[2])
`, crx, extDir]);
  await writeFile(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Local QA' } } } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const appArgs = process.env.PILION_PACKAGED_QA === '1' ? [] : [repo];
  let app;
  async function launch() {
    app = await _electron.launch({ executablePath, args: [...appArgs, `--user-data-dir=${profile}`, '--no-first-run'], cwd: repo,
      env: { ...process.env, NODE_ENV: 'test', PILION_E2E_NO_FOCUS: '1', PILION_INTEGRATION_HOME: join(runDir, 'integration'), LOCALAPPDATA: localAppData } });
    for (const stream of ['stdout', 'stderr'])
      app.process()[stream].on('data', data => process.stdout.write(`[app ${stream}] ${data}`));
    console.log('diagnostic: launched pid', app.process().pid, 'at', new Date().toISOString());
    await app.evaluate(({ app, session }, home) => {
      app.setPath('home', home);
      session.fromPartition('persist:pilion-default').webRequest.onBeforeRequest(({ url }, done) => {
        const parsed = new URL(url);
        done({ cancel: ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname !== '127.0.0.1' });
      });
    }, home);
    const main = await find(app, url => url.startsWith('file:') && url.endsWith('/index.html'));
    await expect.poll(() => main.evaluate(async () => Boolean((await window.pilion.getState()).activeTabId))).toBe(true);
    return main;
  }
  try {
    let main = await launch();
    await main.getByRole('button', { name: '扩展与浏览器数据', exact: true }).click();
    const cookie = main.getByLabel('Cookie / 登录态', { exact: false });
    if (await cookie.isChecked()) await cookie.uncheck();
    await main.getByRole('button', { name: '确认导入所选数据' }).click();
    await expect(main.getByText('Tampermonkey', { exact: true })).toBeVisible();
    const consent = main.getByLabel('允许 Tampermonkey 执行用户脚本', { exact: true });
    await expect(consent).not.toBeChecked();
    await expect(consent).toBeDisabled();
    console.log('Stock Electron imported the real extension and safely leaves native consent unavailable.');
    return;
    await consent.click();
    await expect(consent).toBeChecked();
    console.log('import and explicit consent passed');
    await main.getByRole('button', { name: '关闭扩展管理' }).click();
    await main.evaluate(url => window.pilion.tabs.navigate(url), pageUrl);
    await main.getByRole('button', { name: '扩展程序', exact: true }).click();
    const menu = await find(app, url => url.includes('window=extensions-menu'));
    await menu.getByRole('button', { name: 'Tampermonkey', exact: true }).click();
    const popup = await find(app, url => url.startsWith('chrome-extension:') && url.endsWith('/action.html'));
    console.log('selected from popup', await popup.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map(({ id, url }) => ({ id, url }))));
    await popup.getByText('Create a new script...', { exact: true }).click({ timeout: 5000 });
    const editor = await find(app, url => url.startsWith('chrome-extension:') && url.includes('/options.html') && url.includes('new-user-script'));
    console.log('editor opened', editor.url());
    await editor.locator('.CodeMirror').waitFor({ timeout: 8000 });
    const source = ['// ==UserScript==', '// @name         Pilion Local QA', '// @namespace    https://pilion.test/', '// @version      1.0.0', '// @match        http://127.0.0.1/*', '// @grant        none', '// ==/UserScript==', 'document.documentElement.dataset.pilionQa = "executed";'].join('\n');
    await editor.locator('.CodeMirror').evaluate((node, text) => node.CodeMirror.setValue(text), source);
    await editor.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await expect(editor.getByText('Pilion Local QA', { exact: true })).toBeVisible({ timeout: 8000 });
    async function assertInjection(targetPath, enabled) {
      const target = new URL(targetPath, pageUrl).href;
      await main.evaluate(url => window.pilion.tabs.navigate(url), target);
      const tab = await find(app, url => url === target);
      await tab.waitForLoadState('load');
      const markup = tab.locator('html');
      if (enabled) await expect(markup).toHaveAttribute('data-pilion-qa', 'executed', { timeout: 5000 });
      else {
        await markup.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
        await expect(markup).not.toHaveAttribute('data-pilion-qa', 'executed');
      }
    }
    await assertInjection('/first', true);
    await assertInjection('/second', true);
    console.log('saved userscript injects after navigation');
    await app.close();
    main = await launch();
    await assertInjection('/after-restart', true);
    console.log('restart recovery passed');
    await main.getByRole('button', { name: '扩展与浏览器数据', exact: true }).click();
    const restored = main.getByLabel('允许 Tampermonkey 执行用户脚本', { exact: true });
    await expect(restored).toBeChecked();
    await restored.click();
    await expect(restored).not.toBeChecked();
    await main.getByRole('button', { name: '关闭扩展管理' }).click();
    await assertInjection('/after-revoke', false);
    console.log('revocation passed');
  } finally {
    if (app) await app.close().catch(() => app.process().kill());
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
