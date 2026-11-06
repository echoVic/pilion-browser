import { useEffect, useState } from 'react';
import { Pin, PinOff, Puzzle, Settings2, X } from 'lucide-react';
import type { ExtensionView, ExtensionToolbarAction } from '../shared/contracts';
import { applyTheme, cachedTheme, IconButton } from './ui';

export function ExtensionIcon({ item }: { item: ExtensionView }) {
  return item.icon ? (
    <img className="extension-icon" src={item.icon} alt="" />
  ) : (
    <Puzzle className="extension-icon" aria-hidden="true" />
  );
}
export function ExtensionsMenu() {
  const [items, setItems] = useState<ExtensionView[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    applyTheme(cachedTheme());
    let live = true;
    const refresh = () =>
      void window.pilion.browserData
        .toolbarItems()
        .then((items) => {
          if (live) setItems(items);
        })
        .catch((error) => {
          if (live) setError(String(error));
        });
    refresh();
    const off = window.pilion.browserData.onExtensionsChanged(refresh);
    return () => {
      live = false;
      off();
    };
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void window.pilion.browserData.toolbarAction({ action: 'close' }).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const act = async (action: ExtensionToolbarAction) => {
    setBusy(true);
    setError('');
    try {
      await window.pilion.browserData.toolbarAction(action);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="extensions-menu">
      <header>
        <h1>扩展程序</h1>
        <IconButton label="关闭扩展程序" onClick={() => void act({ action: 'close' })}>
          <X size={18} />
        </IconButton>
      </header>
      <p className="extensions-menu-hint">点击打开扩展；固定后可从工具栏直接使用。</p>
      <div className="extensions-menu-list">
        {items.length ? (
          items.map((item) => (
            <div key={item.id} className="extensions-menu-row">
              <button
                className="extension-launch"
                disabled={busy || !item.enabled || !!item.error}
                onClick={() => void act({ action: 'open', id: item.id })}
                title={
                  item.error || `${item.name} ${item.version}${item.enabled ? '' : ' · 已停用'}`
                }
              >
                <ExtensionIcon item={item} />
                <span>
                  {item.name}
                  {!item.enabled ? <small>已停用</small> : null}
                </span>
              </button>
              <IconButton
                label={`${item.pinned ? '取消固定' : '固定'} ${item.name}`}
                title={item.pinned ? '从工具栏取消固定' : '固定到工具栏'}
                aria-pressed={!!item.pinned}
                className={item.pinned ? 'extension-pin-active' : ''}
                disabled={busy}
                onClick={() => void act({ action: 'pin', id: item.id, pinned: !item.pinned })}
              >
                {item.pinned ? <PinOff size={17} /> : <Pin size={17} />}
              </IconButton>
            </div>
          ))
        ) : (
          <p className="extensions-menu-empty">尚未安装扩展。可在管理页导入或加载。</p>
        )}
      </div>
      {error ? (
        <p className="extensions-menu-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="extensions-menu-manage" onClick={() => void act({ action: 'manage' })}>
        <Settings2 size={19} />
        管理扩展程序
      </button>
    </main>
  );
}
