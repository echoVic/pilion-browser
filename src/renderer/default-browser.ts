import type { DefaultBrowserStatus } from '../shared/contracts';

interface DefaultBrowserApi {
  get(): Promise<DefaultBrowserStatus>;
  set(): Promise<DefaultBrowserStatus>;
}

export function observeDefaultBrowser(
  api: DefaultBrowserApi,
  onStatus: (status: DefaultBrowserStatus) => void,
  run: (action: () => Promise<unknown>) => Promise<boolean>,
  focus: EventTarget,
) {
  let disposed = false;
  let revision = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  const read = (action: () => Promise<DefaultBrowserStatus>) => {
    const current = ++revision;
    return run(async () => {
      const status = await action();
      if (!disposed && current === revision) onStatus(status);
    });
  };
  const refresh = () => {
    void read(() => api.get());
  };
  const stopPolling = () => {
    clearInterval(interval);
  };
  focus.addEventListener('focus', refresh);
  refresh();
  return {
    request: () => {
      if (disposed) return Promise.resolve(false);
      stopPolling();
      // 系统确认不随 IPC 一起结束，给人 20 秒决定，焦点回来时仍会重查。
      const until = Date.now() + 20_000;
      interval = setInterval(() => {
        refresh();
        if (Date.now() >= until) stopPolling();
      }, 1_000);
      return read(() => api.set());
    },
    dispose() {
      disposed = true;
      stopPolling();
      focus.removeEventListener('focus', refresh);
    },
  };
}
