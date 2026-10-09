import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, Cpu, Laptop, Moon, SlidersHorizontal, Sun, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { LocalAgentPreset } from '../shared/local-agents';
import { SEARCH_ENGINES, type SearchEngine } from '../shared/search-engines';
import type { AppSettings, AppSettingsPatch } from '../shared/settings';
import { AgentSettings } from './AgentSettings';
import { applyTheme, cachedTheme, failureText, IconButton } from './ui';

const PANES = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'agent', label: 'Agent', icon: Cpu },
] as const;
type Pane = (typeof PANES)[number]['id'];

const THEMES = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'auto', label: '跟随系统', icon: Laptop },
  { value: 'dark', label: '深色', icon: Moon },
] as const;

/**
 * 设置窗口的根组件。主进程用 ?window=preferences 打开同一份渲染层；这里只订阅状态，
 * 只调用主进程为设置窗口放行的那几条通道（设置与 Agent 连接）。
 */
export function PreferencesWindow() {
  const [state, setState] = useState<AppState>();
  const [pane, setPane] = useState<Pane>('general');
  const [error, setError] = useState('');
  // 每次从入口打开都算一次新的进入：连接表单从头开始，带了预设就预选它。
  const [opening, setOpening] = useState<{ count: number; preset?: LocalAgentPreset }>({
    count: 0,
  });
  const settings = state?.settings;
  const theme = settings?.theme ?? cachedTheme();
  useEffect(() => {
    document.title = 'Pilion 设置';
  }, []);
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(
    () =>
      window.pilion.settings.onOpen((target) => {
        if (target.pane) setPane(target.pane);
        setError('');
        setOpening((current) => ({ count: current.count + 1, preset: target.preset }));
      }),
    [],
  );
  useEffect(() => {
    let received = false;
    const off = window.pilion.onState((next) => {
      received = true;
      setState(next);
    });
    void window.pilion
      .getState()
      .then((next) => {
        if (!received) setState(next);
      })
      .catch((cause) => setError(failureText(cause)));
    return off;
  }, []);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(failureText(cause));
      return false;
    }
  }, []);
  const save = (patch: AppSettingsPatch) => void run(() => window.pilion.settings.save(patch));
  const current = PANES.find((item) => item.id === pane)!;
  return (
    <main
      className={clsx('prefs-shell', {
        'platform-macos': navigator.userAgent.includes('Macintosh'),
      })}
    >
      <nav className="prefs-nav" aria-label="设置分类">
        {PANES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={clsx({ selected: pane === id })}
            aria-current={pane === id ? 'page' : undefined}
            onClick={() => {
              setPane(id);
              setError('');
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>
      <section className="prefs-main">
        <header className="prefs-header">
          <h1>{current.label}</h1>
        </header>
        <div className="prefs-content">
          {error && (
            <div className="prefs-error" role="alert">
              <CircleAlert size={15} />
              <span>{error}</span>
              <IconButton label="关闭提示" onClick={() => setError('')}>
                <X size={14} />
              </IconButton>
            </div>
          )}
          {state && settings ? (
            pane === 'general' ? (
              <GeneralPane settings={settings} theme={theme} save={save} />
            ) : (
              <AgentPane
                key={opening.count}
                state={state}
                settings={settings}
                preset={opening.preset}
                save={save}
                run={run}
              />
            )
          ) : null}
        </div>
      </section>
    </main>
  );
}

function GeneralPane({
  settings,
  theme,
  save,
}: {
  settings: AppSettings;
  theme: string;
  save(patch: AppSettingsPatch): void;
}) {
  return (
    <>
      <section className="prefs-section">
        <h2>外观</h2>
        <span className="prefs-label" id="prefs-theme">
          主题
        </span>
        <div className="segmented three" role="group" aria-labelledby="prefs-theme">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              aria-pressed={theme === value}
              className={clsx({ selected: theme === value })}
              onClick={() => save({ theme: value })}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="prefs-section">
        <h2>启动</h2>
        <Choice
          name="startupBehavior"
          label="打开 Pilion 时"
          value={settings.startupBehavior}
          options={[
            { value: 'restore', title: '恢复上次的标签页', detail: '回到上次退出时打开的网页。' },
            { value: 'new', title: '打开新标签页', detail: '从一个空白标签页开始。' },
          ]}
          onChange={(value) => save({ startupBehavior: value })}
        />
      </section>
      <section className="prefs-section">
        <h2>搜索</h2>
        <label className="prefs-label" htmlFor="prefs-search-engine">
          地址栏搜索引擎
        </label>
        <select
          id="prefs-search-engine"
          className="prefs-select"
          value={settings.searchEngine}
          onChange={(event) => save({ searchEngine: event.target.value as SearchEngine })}
        >
          {Object.entries(SEARCH_ENGINES).map(([value, engine]) => (
            <option key={value} value={value}>
              {engine.name}
            </option>
          ))}
        </select>
      </section>
      <section className="prefs-section">
        <h2>窗口</h2>
        <label className="prefs-option">
          <input
            type="checkbox"
            checked={settings.quitOnWindowClose}
            onChange={(event) => save({ quitOnWindowClose: event.target.checked })}
          />
          <span>
            <strong>关闭窗口时退出 Pilion</strong>
            <small>
              不勾选时，关闭窗口只是把它藏起来，Agent 连接和进行中的任务都保留，点 Dock
              图标就能回来。
            </small>
          </span>
        </label>
      </section>
    </>
  );
}

function AgentPane({
  state,
  settings,
  preset,
  save,
  run,
}: {
  state: AppState;
  settings: AppSettings;
  preset?: LocalAgentPreset;
  save(patch: AppSettingsPatch): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  return (
    <>
      <section className="prefs-section">
        <h2>任务执行</h2>
        <Choice
          name="agentWindowBehavior"
          label="Agent 操作页面时"
          value={settings.agentWindowBehavior}
          options={[
            {
              value: 'foreground',
              title: '前台显示',
              detail: 'Agent 开始操作时把 Pilion 带到最前，方便你看着它做。',
            },
            {
              value: 'silent',
              title: '后台静默',
              detail:
                'Agent 在后台操作，不打断你正在用的其他应用；需要你确认或接管时，Dock 图标会跳动提醒。',
            },
          ]}
          onChange={(value) => save({ agentWindowBehavior: value })}
        />
      </section>
      <section className="prefs-section">
        <h2>连接</h2>
        <AgentSettings state={state} run={run} initialPreset={preset} />
      </section>
    </>
  );
}

function Choice<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  options: readonly { value: T; title: string; detail: string }[];
  onChange(value: T): void;
}) {
  return (
    <fieldset className="prefs-choice">
      <legend className="prefs-label">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="prefs-option">
          <input
            type="radio"
            name={name}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
