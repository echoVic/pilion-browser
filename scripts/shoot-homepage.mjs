#!/usr/bin/env node
/* global console, document, devicePixelRatio, process, setTimeout, window */
/**
 * 用 mock 数据截取 echovic 主页要用的 Pilion 界面图。
 *
 * 走真实 Electron 窗口，但 profile、网站、Agent 对话和设置全部是临时的合成数据：
 * 网页来自本脚本内起的本地站点，Agent 是 tests/fixtures/e2e-agent.mjs，设置项写在临时
 * profile 里，不读个人数据目录、不连真实模型。网页页脚标注「演示内容」，人名、文章与
 * 任务名都是编的。
 *
 * 原生网页视图不在窗口渲染层的截图里，所以每张图拆成两部分：
 *   parts/<name>-shell.png  渲染层（侧栏、Agent 面板等）
 *   parts/<name>-page.png   当前标签页的网页
 *   parts/<name>.json       网页视图在窗口里的位置（DIP），交给 tools/compose 合成。
 *
 * 用法：先 `pnpm build`，再 `node scripts/shoot-homepage.mjs`，产物写到 .screenshots/homepage/。
 * 只在需要换主页截图时手动运行，不进 CI。
 */
import { _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const outDir = join(projectRoot, '.screenshots', 'homepage');
const partsDir = join(outDir, 'parts');
const HOST = 'morrow.test';

const CSS = `
  :root{color-scheme:light;--bg:#fbfaf7;--panel:#ffffff;--ink:#17161a;--muted:#6f6b66;--line:#e7e3db;--accent:#2f5d50}
  @media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#131417;--panel:#17181c;--ink:#eeece8;--muted:#a09b93;--line:#2a2b30;--accent:#8fc7b2}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Songti SC","Noto Serif SC",Georgia,serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:880px;margin:0 auto;padding:52px 44px 70px}
  header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:18px}
  .brand{font:600 14px/1 -apple-system,"PingFang SC",system-ui;letter-spacing:.24em}
  nav a{margin-left:26px;color:var(--muted);text-decoration:none;font:400 13px/1 -apple-system,"PingFang SC",system-ui}
  h1{font-size:44px;line-height:1.26;margin:58px 0 14px;letter-spacing:.01em}
  .lede{color:var(--muted);font-size:16px;line-height:1.95;max-width:540px;margin:0 0 44px}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .card{border:1px solid var(--line);border-radius:14px;padding:22px 24px 24px;background:var(--panel)}
  .card small{font:500 11px/1 -apple-system,"PingFang SC",system-ui;letter-spacing:.18em;color:var(--accent)}
  .card h2{font-size:21px;line-height:1.5;margin:13px 0 9px}
  .card p{margin:0;color:var(--muted);font-size:13.5px;line-height:1.8}
  .list{margin-top:44px;border-top:1px solid var(--line)}
  .row{display:flex;justify-content:space-between;gap:24px;padding:17px 2px;border-bottom:1px solid var(--line);font:400 15px/1.6 -apple-system,"PingFang SC",system-ui}
  .row span:last-child{color:var(--muted);font-size:13px;white-space:nowrap}
  footer{margin-top:52px;color:var(--muted);opacity:.7;font:400 11px/1.6 -apple-system,"PingFang SC",system-ui}
  article{max-width:660px;margin:0 auto}
  .kick{font:500 11px/1 -apple-system,"PingFang SC",system-ui;letter-spacing:.2em;color:var(--accent)}
  article h1{font-size:36px;line-height:1.4;margin:18px 0 10px}
  .byline{color:var(--muted);font:400 12px/1 -apple-system,"PingFang SC",system-ui;margin-bottom:34px}
  article p{font-size:16.5px;line-height:2;margin:0 0 20px}
  blockquote{margin:32px 0;padding-left:18px;border-left:2px solid var(--line);color:var(--muted);font-size:17px}
  @media (max-width:760px){
    .wrap{padding:34px 26px 54px}
    h1{font-size:32px;margin-top:40px}
    .cards{grid-template-columns:1fr}
    article h1{font-size:28px}
  }`;

const page = (title, body) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;

const site = {
  '/': page(
    'Morrow 每日阅读',
    `<div class="wrap"><header><div class="brand">MORROW</div><nav><a>今日</a><a>专题</a><a>存档</a><a>关于</a></nav></header>
<h1>留一点空间，给今天。</h1>
<p class="lede">每天三篇，慢慢读。把屏幕上的喧闹关掉，留一段不被打断的时间。</p>
<div class="cards">
  <div class="card"><small>01 · TODAY</small><h2>今天想读的<br>三篇文章</h2><p>设计、工具与日常灵感，每篇约八分钟。</p></div>
  <div class="card"><small>02 · IDEAS</small><h2>把重复步骤，<br>交给自己的 Agent</h2><p>整理公开资料，留待人工确认。</p></div>
</div>
<div class="list">
  <div class="row"><span>注意力是一种可以攒下来的东西</span><span>7 分钟</span></div>
  <div class="row"><span>在信息过载的早晨，先做减法</span><span>6 分钟</span></div>
  <div class="row"><span>把浏览器变成工作台的三件小事</span><span>9 分钟</span></div>
</div>
<footer>演示内容 · 本地合成网页，与任何真实网站无关</footer></div>`,
  ),
  '/article': page(
    '注意力是一种可以攒下来的东西 · Morrow',
    `<div class="wrap"><article><div class="kick">TODAY · 01</div>
<h1>注意力是一种可以攒下来的东西</h1>
<div class="byline">Morrow 编辑部 · 7 分钟</div>
<p>我们常常以为专注是一种天赋：有人坐得住，有人坐不住。可它更像一笔存款，前一天睡得够、放得下，第二天才有得取。</p>
<p>把浏览器当作工作台的人尤其容易忘记这一点。一个标签页打开，是另一件未完成的事；一次跳转，是又一条没有结尾的线。等到回过神来，上午已经过去，手里却什么都没有留下。</p>
<blockquote>留一点空白不是偷懒，而是给下一步留出落脚的余地。</blockquote>
<p>所以今天的建议很简单：只开三篇，只读一篇。读完再决定要不要继续。你会发现，真正想做的事并没有因此变少。</p>
<footer>演示内容 · 本地合成网页，与任何真实网站无关</footer></article></div>`,
  ),
  '/design': page(
    '设计参考 · Morrow',
    `<div class="wrap"><header><div class="brand">MORROW</div><nav><a>今日</a><a>专题</a><a>存档</a><a>关于</a></nav></header>
<h1>设计参考：留白、字距和一条细线。</h1>
<p class="lede">收集来的页面与组件，按主题整理。只保留还能想起来为什么要收的那些。</p>
<div class="list">
  <div class="row"><span>阅读页的字号阶梯与行高</span><span>排版</span></div>
  <div class="row"><span>用一条发丝线代替四层边框</span><span>层级</span></div>
  <div class="row"><span>侧栏胶囊地址栏的两种做法</span><span>导航</span></div>
</div>
<footer>演示内容 · 本地合成网页，与任何真实网站无关</footer></div>`,
  ),
  '/weekend': page(
    '周末计划 · Morrow',
    `<div class="wrap"><header><div class="brand">MORROW</div><nav><a>今日</a><a>专题</a><a>存档</a><a>关于</a></nav></header>
<h1>周末计划：把要做的事减到三件。</h1>
<p class="lede">周六上午去美术馆，下午把阳台收拾出来；周日只留一顿饭和一段不被打断的阅读。</p>
<div class="cards">
  <div class="card"><small>SAT</small><h2>上午 · 美术馆</h2><p>十点开门，提前十分钟到。</p></div>
  <div class="card"><small>SUN</small><h2>下午 · 慢慢读</h2><p>把手机放到另一个房间。</p></div>
</div>
<footer>演示内容 · 本地合成网页，与任何真实网站无关</footer></div>`,
  ),
};

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const html = site[path] ?? site['/'];
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
const base = `http://${HOST}`;

await mkdir(partsDir, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'pilion-homepage-'));
const integrationHome = '/tmp/pilion-homepage-home';
await rm(integrationHome, { recursive: true, force: true });
await mkdir(integrationHome, { recursive: true });
// 有些启动环境（例如从 IDE 终端）会带 ELECTRON_RUN_AS_NODE=1，Electron 会把自己当 Node 跑。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [
    projectRoot,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    // 让地址栏显示 morrow.test 而不是 127.0.0.1:端口；只影响这次临时进程。
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${port}`,
  ],
  cwd: projectRoot,
  env: {
    ...env,
    NODE_ENV: 'test',
    PILION_E2E_NO_FOCUS: '1',
    PILION_INTEGRATION_HOME: integrationHome,
  },
  timeout: 30_000,
});

let main;
const state = () => main.evaluate(() => window.pilion.getState());
const sleep = (ms) => new Promise((ready) => setTimeout(ready, ms));
const waitFor = async (check, what, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const pending = check();
    const value =
      pending && typeof pending.then === 'function'
        ? await pending.catch(() => undefined)
        : pending;
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
};
const shellWindowId = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => {
      const url = candidate.webContents.getURL();
      return url.includes('dist-renderer/index.html') && !url.includes('?window=');
    });
    return win ? win.id : null;
  });
const resize = async (width, height) => {
  const id = await shellWindowId();
  await app.evaluate(
    ({ BrowserWindow }, [windowId, size]) => {
      BrowserWindow.fromId(windowId)?.setSize(size[0], size[1]);
    },
    [id, [width, height]],
  );
  await sleep(500);
};
const theme = async (value) => {
  await main.evaluate((mode) => window.pilion.settings.save({ theme: mode }), value);
  await waitFor(
    () => main.evaluate((mode) => document.documentElement.dataset.theme === mode, value),
    `${value} theme`,
  );
  await sleep(400);
};
const activeTab = async () => {
  const snapshot = await state();
  return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
};

/**
 * 渲染层和当前网页视图分开截。includePage=false 用于设置窗口这类没有网页视图的界面。
 */
async function shoot(name, { includePage = true, pageUrl, colorScheme = 'light' } = {}) {
  const shell = await main.screenshot();
  await writeFile(join(partsDir, `${name}-shell.png`), shell);
  const meta = {
    scale: await main.evaluate(() => devicePixelRatio),
    viewBounds: null,
    pageUrl: null,
  };
  if (includePage) {
    const target = pageUrl ?? (await activeTab())?.url;
    if (!target) throw new Error(`No active tab for ${name}`);
    const view = app.windows().find((candidate) => candidate.url() === target);
    if (!view) throw new Error(`No page target for ${target}`);
    meta.pageUrl = target;
    await view.emulateMedia({ colorScheme });
    await writeFile(join(partsDir, `${name}-page.png`), await view.screenshot());
    meta.viewBounds = await app.evaluate(({ BrowserWindow }, url) => {
      const shellWindow = BrowserWindow.getAllWindows().find((win) => {
        const current = win.webContents.getURL();
        return current.includes('dist-renderer/index.html') && !current.includes('?window=');
      });
      const child = shellWindow?.contentView.children.find(
        (item) =>
          'webContents' in item && item.webContents && String(item.webContents.getURL()) === url,
      );
      return child ? child.getBounds() : null;
    }, target);
    if (!meta.viewBounds) throw new Error(`Could not read the page view bounds for ${target}`);
  }
  await writeFile(join(partsDir, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`shot ${name}`);
}

const activate = async (path) => {
  const url = `${base}${path}`;
  const tab = (await state()).tabs.find((item) => item.url === url);
  if (!tab) throw new Error(`No tab for ${url}`);
  await main.evaluate((id) => window.pilion.tabs.activate(id), tab.id);
  await waitFor(async () => (await state()).activeTabId === tab.id, `active tab ${url}`);
  await sleep(700);
  return tab;
};
const open = async (path) => {
  const url = `${base}${path}`;
  await main.evaluate((target) => window.pilion.tabs.open(target), url);
  await waitFor(async () => (await state()).tabs.some((tab) => tab.url === url), `tab ${url}`);
  await sleep(900);
  const snapshot = await state();
  const tab = snapshot.tabs.find((item) => item.url === url);
  await main.evaluate((id) => window.pilion.tabs.activate(id), tab.id);
  await waitFor(async () => (await state()).activeTabId === tab.id, `active tab ${url}`);
  await sleep(700);
  return tab;
};

try {
  main = await waitFor(async () => {
    for (const candidate of app.windows()) {
      const shell = await candidate
        .evaluate(() => typeof window.pilion === 'object')
        .catch(() => false);
      if (shell) return candidate;
    }
    return undefined;
  }, 'main window');
  await main.waitForLoadState('domcontentloaded');
  await waitFor(
    () => main.evaluate(() => window.pilion.getState().then((value) => value.tabs.length >= 1)),
    'tabs',
  );

  await main.evaluate((agent) => window.pilion.agents.save(agent), {
    id: 'homepage-agent',
    name: 'Claude Code',
    command: process.execPath,
    args: [join(projectRoot, 'tests/fixtures/e2e-agent.mjs')],
    cwd: projectRoot,
    enabled: true,
  });
  await main.evaluate(() => window.pilion.agents.connect('homepage-agent'));
  await waitFor(
    () =>
      main.evaluate(() => window.pilion.getState().then((value) => value.agentStatus === 'ready')),
    'agent ready',
  );

  await resize(1440, 900);
  await theme('light');
  await main.evaluate(() => window.pilion.workspace.dockAgentPanel());
  await sleep(400);

  // 侧栏里放几个看起来像日常使用的标签，全部是合成网页。
  await open('/');
  await open('/article');
  await open('/design');
  await open('/weekend');
  const home = await activate('/');
  await main.evaluate(() => window.pilion.workspace.toggleBookmark());
  await sleep(500);
  console.log('url', home.url, 'title', home.title);

  await shoot('hero-light');

  await theme('dark');
  await activate('/article');
  await shoot('hero-dark', { colorScheme: 'dark' });

  await theme('light');
  await resize(900, 720);
  await activate('/');
  await shoot('narrow');
  await resize(1440, 900);

  // 03 / 审批：ask 模式下让 mock Agent 尝试点一下，审批卡就地展开。
  main.on('pageerror', (error) => console.log('pageerror', error.message));
  await main.evaluate(() => window.pilion.agents.setMode('ask'));
  await main.getByLabel('输入任务').fill('ACP 审批');
  await main.getByRole('button', { name: '发送', exact: true }).click();
  await main.locator('.approval-dock').waitFor({ state: 'visible', timeout: 30_000 });
  const summary = main.locator('.approval-dock summary');
  if ((await summary.getAttribute('aria-expanded')) === 'false') await summary.click();
  await sleep(500);
  await shoot('approval');
  await main
    .getByRole('button', { name: '拒绝', exact: true })
    .click()
    .catch(() => undefined);
  await sleep(800);
  await main.getByRole('button', { name: '新对话', exact: true }).click();
  await sleep(600);

  // 设置窗口：通用（含「安装到 Agent」）、Agent 列表、远端 SSH 表单。
  const preferences = async (pane) => {
    await main.evaluate((target) => window.pilion.settings.open({ pane: target }), pane);
    const page = await waitFor(
      () => app.windows().find((candidate) => candidate.url().includes('window=preferences')),
      `preferences ${pane}`,
    );
    await page.waitForLoadState('domcontentloaded');
    await sleep(800);
    return page;
  };
  const shootPage = async (name, page) => {
    await page.screenshot({ path: join(partsDir, `${name}.png`) });
    console.log(`shot ${name}`);
  };
  const resizePreferences = () =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes('window=preferences'),
      );
      win?.setSize(1080, 860);
    });

  await main.evaluate(() => window.pilion.settings.save({ externalControl: true }));
  let prefs = await preferences('general');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().includes('window=preferences'))
      ?.setSize(1080, 760);
  });
  await sleep(600);
  await shootPage('prefs-general', prefs);
  const installButton = prefs.getByRole('button', { name: '安装到 Agent' });
  await installButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await sleep(400);
  await shootPage('prefs-install-agent', prefs);
  await installButton.click();
  await waitFor(
    () => prefs.getByRole('button', { name: '移除', exact: true }).isVisible(),
    'integration installed',
  );

  // 02 / 任务空间：用安装好的 pilion CLI 建两个 Agent 空间，再截空间切换浮层。
  const shim = join(integrationHome, '.local', 'bin', 'pilion');
  const runCli = (args, extraEnv = {}) =>
    new Promise((done) => {
      execFile(
        shim,
        args,
        { env: { PATH: '/usr/bin:/bin', ...extraEnv }, timeout: 60_000 },
        (error, stdout, stderr) => done({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
      );
    });
  const created = await runCli(['space', 'new', '整理阅读清单', '--json']);
  if (created.code !== 0) throw new Error(`space new failed: ${created.stdout}${created.stderr}`);
  const readingSpace = JSON.parse(created.stdout).spaceId;
  await runCli(['new', `${base}/article`, '--json'], { PILION_SPACE: readingSpace });
  const second = await runCli(['space', 'new', '查周末去处', '--json']);
  if (second.code !== 0) throw new Error(`space new failed: ${second.stdout}${second.stderr}`);
  const weekendSpace = JSON.parse(second.stdout).spaceId;
  await runCli(['new', `${base}/weekend`, '--json'], { PILION_SPACE: weekendSpace });
  await sleep(1200);

  await main.getByRole('button', { name: /^切换空间：/ }).click();
  await main.getByRole('group', { name: 'Agent 空间' }).waitFor({ state: 'visible' });
  await sleep(500);
  await shoot('spaces');
  await main.keyboard.press('Escape');
  await sleep(400);

  // 04 / Agent 列表与远端：先把临时 Agent 换掉，避免设置里出现本机路径。
  await main.evaluate(() => window.pilion.agents.disconnect().catch(() => undefined));
  await main.evaluate(() => window.pilion.agents.remove('homepage-agent'));
  await main.evaluate(
    (agents) => Promise.all(agents.map((agent) => window.pilion.agents.save(agent))),
    [
      {
        id: 'mock-claude',
        name: 'Claude Code',
        command: '/usr/local/bin/claude',
        args: ['--acp'],
        cwd: '~',
        enabled: false,
      },
      {
        id: 'mock-codex',
        name: 'Codex',
        command: '/opt/homebrew/bin/codex',
        args: ['acp'],
        cwd: '~',
        enabled: false,
      },
    ],
  );
  prefs = await preferences('agent');
  await resizePreferences();
  await sleep(600);
  await prefs.getByRole('button', { name: '自定义 / 远端' }).click();
  await sleep(500);
  await prefs
    .getByRole('button', { name: '添加 Agent', exact: true })
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await sleep(400);
  await shootPage('prefs-agents', prefs);
  await prefs.getByRole('button', { name: '添加 Agent', exact: true }).click();
  await prefs.getByRole('button', { name: '远端 SSH', exact: true }).click();
  await prefs.getByLabel('SSH 主机').fill('dev@build.example');
  const remoteDir = prefs.getByLabel(/目录|工作目录/).first();
  await remoteDir.fill('/srv/agent-workspace').catch(() => undefined);
  await sleep(500);
  await shootPage('prefs-remote', prefs);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((candidate) => candidate.webContents.getURL().includes('window=preferences'))
      ?.close(),
  );
  await sleep(500);

  // 06 / 扩展：用临时 home 里的 Chrome 配置导入一个示例扩展，再截拼图菜单。
  const fakeHome = join(profile, 'home');
  const extensionDirectory = join(
    fakeHome,
    'Library/Application Support/Google/Chrome/Default/Extensions',
    'a'.repeat(32),
    '1.0_0',
  );
  await mkdir(extensionDirectory, { recursive: true });
  await writeFile(
    join(fakeHome, 'Library/Application Support/Google/Chrome/Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: '示例配置' } } } }),
  );
  await writeFile(
    join(extensionDirectory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: '示例扩展',
      version: '1.0',
      action: { default_popup: 'popup.html' },
      content_scripts: [{ matches: ['http://morrow.test/*'], js: ['content.js'] }],
    }),
  );
  await writeFile(
    join(extensionDirectory, 'content.js'),
    'document.documentElement.dataset.pilionExtension = "active";',
  );
  await writeFile(join(extensionDirectory, 'popup.html'), '<html><body>示例扩展</body></html>');
  await app.evaluate(
    ({ app: electronApp }, homePath) => electronApp.setPath('home', homePath),
    fakeHome,
  );
  await main.getByRole('button', { name: '扩展与浏览器数据', exact: true }).click();
  await main.getByLabel('Cookie / 登录态', { exact: false }).uncheck();
  await main.getByRole('button', { name: '确认导入所选数据' }).click();
  await waitFor(() => main.getByText('已导入 1 个扩展').isVisible(), 'extension imported');
  await main.getByRole('button', { name: '关闭扩展管理' }).click();
  await main.getByRole('button', { name: '扩展程序', exact: true }).click();
  const menu = await waitFor(
    () => app.windows().find((candidate) => candidate.url().includes('window=extensions-menu')),
    'extensions menu',
  );
  await menu.waitForLoadState('domcontentloaded');
  await sleep(800);
  await shootPage('extensions-menu', menu);

  console.log('done');
} finally {
  await app.close().catch(() => undefined);
  server.close();
  await rm(profile, { recursive: true, force: true });
  await rm(integrationHome, { recursive: true, force: true });
}
