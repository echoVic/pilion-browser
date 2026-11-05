import { useEffect, useState } from 'react';
import type { BrowserDataSource, ExtensionView } from '../shared/contracts';

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
        if (live) setMessage(String(error));
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
      setMessage(error instanceof Error ? error.message : String(error));
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
