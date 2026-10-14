/**
 * 所有「把窗口/应用提到前台」的动作都收口到这里。
 *
 * 正常模式（人在用 Pilion）下，收到外部链接、菜单动作、设置窗口等都应当真的抢前台焦点——这是产品行为。
 * 但在 E2E 自动化（PILION_E2E_NO_FOCUS=1）下，抢系统焦点会打断用户正在做的事（一边跑测试一边用电脑），
 * 而且 macOS 的 Playwright 自动化里窗口能不能真的拿到前台焦点本来就不受产品控制。所以测试模式下：
 *   - show 改用 showInactive()：窗口可见、可截图、可输入，但不激活应用；
 *   - 不调 app.focus({steal}) / window.focus()；
 *   - webContents.focus() 不调（它在 macOS 上会顺带激活应用）；
 *   - 每次「请求激活」仍会被记录，测试通过 __pilionFocus 钩子断言「产品确实请求了聚焦」。
 *
 * 接入点集中在这一个模块，方便和 fix/bg-tabs 分支的后台标签焦点改动合并。
 */
import { app, BaseWindow, WebContents, type BrowserWindow } from 'electron';

export const e2eNoFocus = process.env.PILION_E2E_NO_FOCUS === '1';

export interface FocusCall {
  kind: 'show' | 'activate' | 'focus-contents';
  /** 与产品真实调用对齐的细分记录：darwin 上 activate 会依次发出 show / app.focus / window.focus。 */
  detail?: string;
  options?: { steal?: boolean };
}

const calls: FocusCall[] = [];

/** 测试用：读取到目前为止记录的「前台焦点请求」。 */
export function focusCalls(): readonly FocusCall[] {
  return calls;
}

/** 测试用：清空记录。 */
export function clearFocusCalls(): void {
  calls.length = 0;
}

function record(call: FocusCall): void {
  calls.push(call);
}

/** 显示窗口。正常模式真 show；测试模式 showInactive，不激活应用。 */
export function showWindow(win: BaseWindow): void {
  record({ kind: 'show', detail: 'showWindow' });
  if (e2eNoFocus) {
    win.showInactive();
    return;
  }
  win.show();
}

/**
 * 请求把主窗口带到前台并激活。正常模式依次 show →（darwin）app.focus({steal:true}) → window.focus，
 * 与历史行为一致；测试模式只记录这一串请求，不真的抢焦点。
 */
export function activateApp(win: BrowserWindow): void {
  record({ kind: 'activate', detail: 'show' });
  if (process.platform === 'darwin')
    record({ kind: 'activate', detail: 'app.focus', options: { steal: true } });
  record({ kind: 'activate', detail: 'window.focus' });
  if (e2eNoFocus) {
    // 窗口仍要可见（测试要截图/输入、真实用户能看到），只是不抢前台焦点。
    win.showInactive();
    return;
  }
  win.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus();
}

/**
 * 把键盘焦点交给某个 webContents。macOS 上这会顺带激活应用，所以测试模式下不调；
 * 非测试模式下与历史行为一致。
 */
export function focusContents(contents: WebContents): void {
  record({ kind: 'focus-contents' });
  if (e2eNoFocus) return;
  contents.focus();
}

/**
 * 测试模式下让 Electron 即使不在前台也照常渲染、计时、接收输入——否则后台窗口被节流，
 * 截图/输入/CDP 会不稳定。必须在 app ready 之前调用。
 */
export function appendBackgroundSwitches(): void {
  if (!e2eNoFocus) return;
  for (const switchName of [
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows',
    'disable-background-timer-throttling',
  ]) {
    app.commandLine.appendSwitch(switchName);
  }
  // macOS 上普通 GUI App 一启动就会被系统激活（抢前台），即使 BrowserWindow 设了 show:false。
  // 把激活策略降到 accessory：不进 Dock、不抢前台，窗口照常 showInactive 显示、可截图/输入。
  if (process.platform === 'darwin') app.setActivationPolicy('accessory');
}

/** 暴露给 E2E 的主进程钩子，测试用 application.evaluate 读取。 */
export function installFocusHook(): void {
  (globalThis as Record<string, unknown>).__pilionFocus = {
    calls: focusCalls,
    clear: clearFocusCalls,
    e2eNoFocus,
  };
}
