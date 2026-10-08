import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Bot, Globe2, Monitor, Moon, Sun, Cpu } from 'lucide-react';
import type { AppSettings } from '../main/settings-store';
import type { AppState } from '../shared/contracts';
import { AgentSettings } from './AgentSettings';

type PrefsTab = 'general' | 'agent';

const SEARCH_ENGINE_OPTIONS: { value: AppSettings['searchEngine']; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'bing', label: 'Bing' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
];

const STARTUP_OPTIONS: { value: AppSettings['startupBehavior']; label: string; description: string }[] = [
  { value: 'restore', label: '恢复上次的标签页', description: '启动时打开上次关闭前的标签页' },
  { value: 'new', label: '新标签页', description: '始终以一个空白标签页启动' },
];

const AGENT_WINDOW_OPTIONS: { value: AppSettings['agentWindowBehavior']; label: string; description: string }[] = [
  { value: 'foreground', label: '前台显示', description: '执行任务时窗口移至前台（默认）' },
  { value: 'silent', label: '后台静默', description: '操作在后台完成，窗口保持当前位置' },
];

export function Preferences({
  state,
  run,
  close,
  importCookies,
}: {
  state: AppState;
  run(action: () => Promise<unknown>): Promise<boolean>;
  close(): void;
  importCookies(): void;
}) {
  const [tab, setTab] = useState<PrefsTab>('general');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const native = Boolean(window.pilion);

  useEffect(() => {
    if (!native) return;
    void window.pilion.settings.get().then(setSettings);
  }, [native]);

  const save = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!native) return;
      setSaving(true);
      try {
        const updated = await window.pilion.settings.save(patch);
        setSettings(updated);
        // Theme change is applied immediately
        if (patch.theme) {
          document.documentElement.dataset.theme = patch.theme;
        }
      } finally {
        setSaving(false);
      }
    },
    [native],
  );

  if (!settings) {
    return (
      <div className="settings-surface">
        <header className="surface-header">
          <div>
            <span className="eyebrow">应用设置</span>
            <h1>设置</h1>
          </div>
        </header>
        <div className="prefs-loading">加载中…</div>
      </div>
    );
  }

  return (
    <div className="prefs-shell">
      <nav className="prefs-nav" aria-label="设置分类">
        <button
          className={clsx('prefs-nav-item', { selected: tab === 'general' })}
          onClick={() => setTab('general')}
        >
          <Monitor size={16} />
          通用
        </button>
        <button
          className={clsx('prefs-nav-item', { selected: tab === 'agent' })}
          onClick={() => setTab('agent')}
        >
          <Cpu size={16} />
          Agent
        </button>
      </nav>

      <div className="prefs-content">
        {tab === 'general' && (
          <GeneralTab settings={settings} save={save} saving={saving} />
        )}
        {tab === 'agent' && (
          <AgentTab
            settings={settings}
            save={save}
            saving={saving}
            state={state}
            run={run}
            close={close}
            importCookies={importCookies}
          />
        )}
      </div>
    </div>
  );
}

function GeneralTab({
  settings,
  save,
  saving,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
  saving: boolean;
}) {
  return (
    <div className="prefs-tab">
      <h2 className="prefs-section-title">外观</h2>
      <div className="prefs-field">
        <label className="prefs-label">主题</label>
        <div className="segmented prefs-segmented">
          {(
            [
              { value: 'light', label: '浅色', Icon: Sun },
              { value: 'auto', label: '跟随系统', Icon: Monitor },
              { value: 'dark', label: '深色', Icon: Moon },
            ] as const
          ).map(({ value, label, Icon }) => (
            <button
              key={value}
              disabled={saving}
              className={clsx({ selected: settings.theme === value })}
              onClick={() => void save({ theme: value })}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <h2 className="prefs-section-title">启动</h2>
      <div className="prefs-field">
        <label className="prefs-label">启动时</label>
        <div className="prefs-radio-group">
          {STARTUP_OPTIONS.map(({ value, label, description }) => (
            <label key={value} className="prefs-radio">
              <input
                type="radio"
                name="startupBehavior"
                value={value}
                checked={settings.startupBehavior === value}
                disabled={saving}
                onChange={() => void save({ startupBehavior: value })}
              />
              <div>
                <span>{label}</span>
                <span className="prefs-description">{description}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      <h2 className="prefs-section-title">浏览</h2>
      <div className="prefs-field">
        <label className="prefs-label" htmlFor="searchEngine">
          默认搜索引擎
        </label>
        <select
          id="searchEngine"
          className="prefs-select"
          value={settings.searchEngine}
          disabled={saving}
          onChange={(e) =>
            void save({ searchEngine: e.target.value as AppSettings['searchEngine'] })
          }
        >
          {SEARCH_ENGINE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <h2 className="prefs-section-title">窗口</h2>
      <div className="prefs-field prefs-field-row">
        <label className="prefs-label" htmlFor="quitOnWindowClose">
          关闭窗口时退出应用
        </label>
        <input
          id="quitOnWindowClose"
          type="checkbox"
          className="prefs-checkbox"
          checked={settings.quitOnWindowClose}
          disabled={saving}
          onChange={(e) => void save({ quitOnWindowClose: e.target.checked })}
        />
      </div>
    </div>
  );
}

function AgentTab({
  settings,
  save,
  saving,
  state,
  run,
  close,
  importCookies,
}: {
  settings: AppSettings;
  save(patch: Partial<AppSettings>): Promise<void>;
  saving: boolean;
  state: AppState;
  run(action: () => Promise<unknown>): Promise<boolean>;
  close(): void;
  importCookies(): void;
}) {
  return (
    <div className="prefs-tab">
      <h2 className="prefs-section-title">任务执行</h2>
      <div className="prefs-field">
        <label className="prefs-label">Agent 操作时的窗口行为</label>
        <div className="prefs-radio-group">
          {AGENT_WINDOW_OPTIONS.map(({ value, label, description }) => (
            <label key={value} className="prefs-radio">
              <input
                type="radio"
                name="agentWindowBehavior"
                value={value}
                checked={settings.agentWindowBehavior === value}
                disabled={saving}
                onChange={() => void save({ agentWindowBehavior: value })}
              />
              <div>
                <span>{label}</span>
                <span className="prefs-description">{description}</span>
              </div>
            </label>
          ))}
        </div>
        {settings.agentWindowBehavior === 'silent' && (
          <p className="prefs-note">
            静默模式下，如果任务需要你在页面手动授权（如证书错误、CAPTCHA），窗口不会自动弹出。
          </p>
        )}
      </div>

      <h2 className="prefs-section-title">连接配置</h2>
      <AgentSettings
        state={state}
        close={close}
        run={run}
        importCookies={importCookies}
      />
    </div>
  );
}
