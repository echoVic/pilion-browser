import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { BrowserDataSource, ExtensionView } from '../shared/contracts';
import { Dialog, DialogContent, DialogTitle, failureText, IconButton } from './ui';

/**
 * 主窗口里的「扩展与浏览器数据」浮层。不走 Portal：浮层留在网页区里定位；
 * 与任务总览一样由 Radix 管焦点圈定、Esc 与点外关闭，关闭后焦点回到打开它的按钮。
 */
export function BrowserDataDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  // 没有 Dialog.Trigger，Radix 关闭时只会把焦点还给 Trigger；记下打开前的焦点自己还回去。
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="browser-data-overlay"
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current;
          returnFocus.current = null;
          if (target?.isConnected) target.focus();
        }}
      >
        <div className="browser-data-header">
          <DialogTitle asChild>
            <strong>扩展与浏览器数据</strong>
          </DialogTitle>
          <IconButton label="关闭扩展管理" onClick={() => onOpenChange(false)}>
            <X size={15} />
          </IconButton>
        </div>
        <BrowserDataPanel />
      </DialogContent>
    </Dialog>
  );
}

export function BrowserDataPanel() {
  const [sources, setSources] = useState<BrowserDataSource[]>([]);
  const [browser, setBrowser] = useState('');
  const [profile, setProfile] = useState('');
  const [cookies, setCookies] = useState(true);
  const [extensions, setExtensions] = useState(true);
  const [installed, setInstalled] = useState<ExtensionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const source = sources.find((item) => item.browser === browser);
  const refresh = async () => setInstalled(await window.pilion.browserData.extensions());
  useEffect(() => {
    let live = true;
    void Promise.all([window.pilion.browserData.sources(), window.pilion.browserData.extensions()])
      .then(([sources, installed]) => {
        if (!live) return;
        setSources(sources);
        setBrowser(sources[0]?.browser ?? '');
        setProfile(sources[0]?.profiles[0]?.id ?? '');
        setInstalled(installed);
        setCookies(sources[0]?.cookies ?? false);
      })
      .catch((error) => {
        if (live) setMessage(failureText(error));
      });
    return () => {
      live = false;
    };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(failureText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="browser-data-panel">
      <section className="prefs-section">
        <h2>导入浏览器数据</h2>
        <p>
          从本机 Chrome、Edge、Brave 或 Chromium 复制 Cookie 和扩展。Cookie
          会合并到当前工作区，Agent
          可使用导入的登录身份。扩展可以读取和修改其授权网站的数据，请只导入你信任的扩展。
        </p>
        {sources.length ? (
          <>
            <label>
              浏览器
              <select
                aria-label="来源浏览器"
                value={browser}
                disabled={busy}
                onChange={(event) => {
                  const next = sources.find((item) => item.browser === event.target.value)!;
                  setBrowser(next.browser);
                  setProfile(next.profiles[0]?.id ?? '');
                  setCookies(next.cookies);
                }}
              >
                {sources.map((item) => (
                  <option key={item.browser} value={item.browser}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              配置文件
              <select
                aria-label="来源配置文件"
                value={profile}
                disabled={busy}
                onChange={(event) => setProfile(event.target.value)}
              >
                {source?.profiles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="browser-data-options">
              <label>
                <input
                  type="checkbox"
                  checked={cookies}
                  disabled={busy || !source?.cookies}
                  onChange={(event) => setCookies(event.target.checked)}
                />
                Cookie / 登录态{!source?.cookies ? '（仅 macOS）' : ''}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={extensions}
                  disabled={busy}
                  onChange={(event) => setExtensions(event.target.checked)}
                />
                扩展
              </label>
            </div>
            <button
              className="primary-button"
              disabled={busy || (!cookies && !extensions) || !profile}
              onClick={() =>
                void perform(async () => {
                  const result = await window.pilion.browserData.import({
                    browser: source!.browser,
                    profile,
                    cookies,
                    extensions,
                  });
                  setMessage(
                    [
                      result.cookies
                        ? `Cookie 导入完成：工作区现有 ${result.cookies.stored} 条，${result.cookies.domains} 个域名；${result.cookies.unreadable} 条无法解密，${result.cookies.rejected} 条被拒绝。`
                        : '',
                      extensions
                        ? `已导入 ${result.extensions} 个扩展（已安装的会保留原状态）。`
                        : '',
                      ...result.failures,
                    ]
                      .filter(Boolean)
                      .join('\n'),
                  );
                })
              }
            >
              {busy ? '正在处理…' : '确认导入所选数据'}
            </button>
          </>
        ) : (
          <p>未找到支持的本机浏览器配置文件。你仍可加载已解压的扩展。</p>
        )}
      </section>
      <section className="prefs-section">
        <h2>扩展管理</h2>
        <p>
          支持已解压的 Manifest V2 / V3 扩展。Electron 只支持部分 Chrome 扩展
          API；部分扩展可能无法工作。不会迁移扩展内的账号、设置，也不会自动更新扩展。
        </p>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void perform(() => window.pilion.browserData.load())}
        >
          加载已解压的扩展…
        </button>
        {!installed.length ? (
          <p>尚未安装扩展</p>
        ) : (
          installed.map((item) => (
            <div className="extension-row" key={item.id}>
              <div>
                <strong>{item.name}</strong> <small>{item.version}</small>
                {item.error ? <p role="alert">{item.error}</p> : null}
              </div>
              <label>
                <input
                  type="checkbox"
                  aria-label={`启用 ${item.name}`}
                  checked={item.enabled}
                  disabled={busy}
                  onChange={(event) =>
                    void perform(() =>
                      window.pilion.browserData.toggle(item.id, event.target.checked),
                    )
                  }
                />
                启用
              </label>
              {item.userScriptsRequired ? (
                <>
                  {item.userScriptsSupported ? null : (
                    <p role="status">当前内核缺少原生 userScripts，用户脚本尚不可执行。</p>
                  )}
                  <label title="允许此扩展在已授权网站上执行用户安装的脚本">
                    <input
                      type="checkbox"
                      aria-label={`允许 ${item.name} 执行用户脚本`}
                      checked={!!item.userScriptsAllowed}
                      disabled={busy || !item.enabled || !item.userScriptsSupported}
                      onChange={(event) =>
                        void perform(() =>
                          window.pilion.browserData.userScripts(item.id, event.target.checked),
                        )
                      }
                    />
                    允许用户脚本
                  </label>
                </>
              ) : null}
              <button
                disabled={busy || !item.enabled || !!item.error}
                onClick={() => void perform(() => window.pilion.browserData.open(item.id))}
              >
                打开
              </button>
              <button
                disabled={busy}
                onClick={() => void perform(() => window.pilion.browserData.remove(item.id))}
              >
                移除
              </button>
            </div>
          ))
        )}
      </section>
      {message ? (
        <p className="browser-data-result" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
