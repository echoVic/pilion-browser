import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * window-focus 把「抢前台焦点」的所有收口点集中起来：正常模式真抢，E2E 模式只记录不抢。
 * 这里用 mock 的 electron 覆盖两种模式的分支。
 */

interface WindowSpy {
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}
interface ContentsSpy {
  focus: ReturnType<typeof vi.fn>;
}

async function loadModule(e2e: boolean) {
  vi.resetModules();
  const calls: { name: string; args?: unknown }[] = [];
  vi.doMock('electron', () => ({
    app: {
      focus: (options?: unknown) => calls.push({ name: 'app.focus', args: options }),
      commandLine: { appendSwitch: (name: string) => calls.push({ name: `switch:${name}` }) },
      setActivationPolicy: (policy: string) => calls.push({ name: `policy:${policy}` }),
    },
    BaseWindow: class {},
    WebContents: class {},
  }));
  if (e2e) process.env.PILION_E2E_NO_FOCUS = '1';
  else delete process.env.PILION_E2E_NO_FOCUS;
  const mod = await import('../src/main/window-focus.js');
  return { mod, calls };
}

afterEach(() => {
  delete process.env.PILION_E2E_NO_FOCUS;
  vi.doUnmock('electron');
});

describe('window-focus 正常模式（人在用 Pilion）', () => {
  it('showWindow 真 show，activateApp 依次 show/app.focus/window.focus，focusContents 真 focus', async () => {
    const { mod, calls } = await loadModule(false);
    const win: WindowSpy = { show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() };
    const wc: ContentsSpy = { focus: vi.fn() };

    mod.showWindow(win as never);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.showInactive).not.toHaveBeenCalled();

    mod.activateApp(win as never);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalledTimes(1);
    if (process.platform === 'darwin') expect(calls.some((c) => c.name === 'app.focus')).toBe(true);
    else expect(calls.some((c) => c.name === 'app.focus')).toBe(false);

    mod.focusContents(wc as never);
    expect(wc.focus).toHaveBeenCalledTimes(1);
  });

  it('正常模式不追加后台渲染开关', async () => {
    const { mod, calls } = await loadModule(false);
    mod.appendBackgroundSwitches();
    expect(calls.filter((c) => c.name.startsWith('switch:'))).toHaveLength(0);
  });
});

describe('window-focus E2E 模式（PILION_E2E_NO_FOCUS=1，不抢系统焦点）', () => {
  it('showWindow 用 showInactive；activateApp/focusContents 只记录不真抢', async () => {
    const { mod } = await loadModule(true);
    expect(mod.e2eNoFocus).toBe(true);
    const win: WindowSpy = { show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() };
    const wc: ContentsSpy = { focus: vi.fn() };

    mod.showWindow(win as never);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();

    mod.clearFocusCalls();
    mod.activateApp(win as never);
    // 真的没调到底层抢焦点 API。
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    // 但记录里有完整的激活请求序列。
    const recorded = mod.focusCalls().filter((c) => c.kind === 'activate');
    expect(recorded[0].detail).toBe('show');
    if (process.platform === 'darwin') {
      expect(recorded[1]).toMatchObject({ detail: 'app.focus', options: { steal: true } });
      expect(recorded[2].detail).toBe('window.focus');
    } else {
      expect(recorded[1].detail).toBe('window.focus');
    }

    mod.focusContents(wc as never);
    expect(wc.focus).not.toHaveBeenCalled();
  });

  it('E2E 模式追加后台渲染开关，避免窗口不在前台时被节流', async () => {
    const { mod, calls } = await loadModule(true);
    mod.appendBackgroundSwitches();
    expect(calls.map((c) => c.name)).toEqual([
      'switch:disable-renderer-backgrounding',
      'switch:disable-backgrounding-occluded-windows',
      'switch:disable-background-timer-throttling',
      // macOS 上额外把激活策略降到 accessory，否则进程一启动就被系统激活抢前台。
      ...(process.platform === 'darwin' ? ['policy:accessory'] : []),
    ]);
  });
});
