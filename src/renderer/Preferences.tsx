import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  CircleAlert,
  Clock,
  Cpu,
  Globe,
  Keyboard,
  Laptop,
  Moon,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import type {
  AppState,
  BrowsingDataClearInput,
  DefaultBrowserStatus,
  ExternalConnectionView,
  ExternalClientView,
  CreatedExternalClient,
  UpdateState,
  UpdateStatus,
} from '../shared/contracts';
import { SHORTCUT_GROUPS, shortcutDisplayRows } from '../shared/keybindings';
import type { LocalAgentPreset } from '../shared/local-agents';
import { SEARCH_ENGINES, type SearchEngine } from '../shared/search-engines';
import type { AppSettings, AppSettingsPatch } from '../shared/settings';
import { describeRule, type ScheduleInput, type ScheduleRule } from '../shared/schedule';
import { AgentSettings } from './AgentSettings';
import { applyTheme, cachedTheme, failureText, IconButton } from './ui';
import { updateButton, updateStatusAnnouncement, updateStatusText } from './update-view';
import { observeDefaultBrowser } from './default-browser';

const PANES = [
  { id: 'general', label: '通用', icon: SlidersHorizontal },
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'schedules', label: '定时任务', icon: Clock },
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
 * 只调用主进程为设置窗口放行的那几条通道（设置、Agent 连接与更新）。
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
  // 新建客户端后明文 token 只展示一次（不落 state、不广播）。
  const [createdToken, setCreatedToken] = useState<CreatedExternalClient | undefined>(undefined);
  const current = PANES.find((item) => item.id === pane)!;
  const mac = navigator.userAgent.includes('Macintosh');
  return (
    <main className={clsx('prefs-shell', { 'platform-macos': mac })}>
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
              <GeneralPane
                settings={settings}
                theme={theme}
                mac={mac}
                save={save}
                update={state.update}
                external={{
                  connections: state.externalConnections ?? [],
                  clients: state.externalClients ?? [],
                  createdToken,
                  onCreated: setCreatedToken,
                }}
                run={run}
              />
            ) : pane === 'browser' ? (
              <BrowserPane
                settings={settings}
                downloadLocation={state.downloadLocation ?? ''}
                run={run}
              />
            ) : pane === 'shortcuts' ? (
              <ShortcutsPane mac={mac} />
            ) : pane === 'schedules' ? (
              <SchedulesPane state={state} run={run} />
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

function ShortcutsPane({ mac }: { mac: boolean }) {
  const rows = shortcutDisplayRows(mac);
  return (
    <>
      {SHORTCUT_GROUPS.map((group) => (
        <section className="prefs-section" key={group}>
          <h2 id={`prefs-shortcuts-${group}`}>{group}</h2>
          <table className="prefs-shortcuts-table" aria-labelledby={`prefs-shortcuts-${group}`}>
            <tbody>
              {rows
                .filter((row) => row.group === group)
                .map((row) => (
                  <tr key={row.action}>
                    <th scope="row">{row.label}</th>
                    <td>
                      {row.keys.map((key, index) => (
                        <Fragment key={key}>
                          {index > 0 && ' / '}
                          <kbd>{key}</kbd>
                        </Fragment>
                      ))}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      ))}
      <p className="prefs-shortcuts-footer">快捷键暂不支持修改。</p>
    </>
  );
}

function GeneralPane({
  settings,
  theme,
  mac,
  save,
  update,
  external,
  run,
}: {
  settings: AppSettings;
  theme: string;
  /** 关窗后藏在 Dock 里只有 macOS 有：别的平台藏起来的窗口找不回来，主进程也不认这一项。 */
  mac: boolean;
  save(patch: AppSettingsPatch): void;
  update?: UpdateState;
  external: {
    connections: ExternalConnectionView[];
    clients: ExternalClientView[];
    createdToken?: CreatedExternalClient;
    onCreated(c: CreatedExternalClient | undefined): void;
  };
  run(action: () => Promise<unknown>): Promise<boolean>;
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
      {mac && (
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
      )}
      <DefaultBrowserSection run={run} />
      <UpdateSection settings={settings} update={update} save={save} run={run} />
      <ExternalControlSection settings={settings} external={external} save={save} run={run} />
    </>
  );
}

function ExternalControlSection({
  settings,
  external,
  save,
  run,
}: {
  settings: AppSettings;
  external: {
    connections: ExternalConnectionView[];
    clients: ExternalClientView[];
    createdToken?: CreatedExternalClient;
    onCreated(c: CreatedExternalClient | undefined): void;
  };
  save(patch: AppSettingsPatch): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [creatingClient, setCreatingClient] = useState(false);
  const on = settings.externalControl;
  // Unix socket 只在 macOS / Linux 上有意义；Windows 上禁用该功能并给出说明。
  const isWindows = navigator.userAgent.includes('Windows');
  const mcpJson = external.createdToken
    ? JSON.stringify({ mcpServers: { pilion: external.createdToken.config } }, null, 2)
    : '';
  function externalCreate(): void {
    const name = newClientName.trim();
    if (!name || creatingClient) return;
    setCreatingClient(true);
    void window.pilion.external
      .createClient(name)
      .then((created) => {
        if (created) {
          external.onCreated(created);
          setNewClientName('');
        }
      })
      .catch(() => undefined)
      .finally(() => setCreatingClient(false));
  }
  return (
    <section className="prefs-section">
      <h2>对外控制（CLI / MCP）</h2>
      {isWindows ? (
        <small>
          该功能基于 Unix domain socket；Windows 上的命名管道 +
          访问控制列表尚需额外实现与验证，暂未开启。
        </small>
      ) : (
        <label className="prefs-option">
          <input
            type="checkbox"
            checked={on}
            onChange={(event) => save({ externalControl: event.target.checked })}
          />
          <span>
            允许本地 CLI / MCP 工具驱动本浏览器
            <small>
              开启后，Pilion 会在用户数据目录下监听一个仅本机当前用户可访问的 Unix socket。
              按客户端签发独立 token，每个客户端独立身份、互相隔离；任何拿到某个客户端 token
              的本地进程都能以该身份驱动这个浏览器——它只会经过和 Agent 相同的审批 /
              审计，但仍请在信任的环境里开启。
            </small>
          </span>
        </label>
      )}
      {on ? (
        <>
          <div className="external-conn-row">
            <input
              className="external-name-input"
              type="text"
              placeholder="新客户端名称（例如 claude-desktop）"
              value={newClientName}
              maxLength={64}
              onChange={(event) => setNewClientName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') externalCreate();
              }}
            />
            <button
              className="secondary-button"
              disabled={!newClientName.trim() || creatingClient}
              onClick={() => externalCreate()}
            >
              {creatingClient ? '创建中…' : '新增客户端'}
            </button>
            <small>每个客户端一个独立 token；token 只在创建时展示一次。</small>
          </div>

          {external.createdToken ? (
            <div className="external-token-box">
              <span className="prefs-label">
                「{external.createdToken.client.name}」的 token（请立即复制，关闭后不再显示）
              </span>
              <code>{external.createdToken.token}</code>
              <button
                className="secondary-button"
                onClick={() => {
                  void navigator.clipboard.writeText(mcpJson).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? '已复制 MCP 配置' : '复制 MCP 配置 JSON'}
              </button>
              <small>
                把上面的 JSON 粘进 Claude Desktop / Cursor 的 mcpServers；CLI 用
                PILION_EXTERNAL_SOCKET / PILION_EXTERNAL_TOKEN 环境变量注入。
              </small>
              <button className="secondary-button" onClick={() => external.onCreated(undefined)}>
                我已保存，关闭
              </button>
            </div>
          ) : null}

          <span className="prefs-label">客户端</span>
          {external.clients.length ? (
            external.clients.map((client) => (
              <div key={client.clientId} className="external-conn-row">
                <span>
                  {client.name}
                  {client.revokedAt ? '（已吊销）' : ''} · 最近{' '}
                  {new Date(client.lastUsedAt).toLocaleString()}
                </span>
                {!client.revokedAt ? (
                  <button
                    className="secondary-button"
                    onClick={() =>
                      void run(() => window.pilion.external.revokeClient(client.clientId))
                    }
                  >
                    吊销
                  </button>
                ) : null}
                <button
                  className="secondary-button"
                  onClick={() =>
                    void run(() => window.pilion.external.deleteClient(client.clientId))
                  }
                >
                  删除
                </button>
              </div>
            ))
          ) : (
            <small>还没有客户端，点「新增客户端」拿第一个 token。</small>
          )}

          <span className="prefs-label">活动外部连接</span>
          {external.connections.length > 0 ? (
            external.connections.map((conn) => (
              <div key={conn.principal} className="external-conn-row">
                <span>
                  {conn.name}（{conn.clientId}）· {new Date(conn.connectedAt).toLocaleTimeString()}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => void run(() => window.pilion.external.disconnect(conn.principal))}
                >
                  断开
                </button>
              </div>
            ))
          ) : (
            <small>暂无活动连接。</small>
          )}
        </>
      ) : null}
    </section>
  );
}

function DefaultBrowserSection({ run }: { run(action: () => Promise<unknown>): Promise<boolean> }) {
  const [status, setStatus] = useState<DefaultBrowserStatus>();
  const observer = useRef<ReturnType<typeof observeDefaultBrowser> | undefined>(undefined);
  useEffect(() => {
    const watching = observeDefaultBrowser(window.pilion.defaultBrowser, setStatus, run, window);
    observer.current = watching;
    return () => {
      watching.dispose();
      observer.current = undefined;
    };
  }, [run]);
  return <DefaultBrowserRow status={status} onSet={() => void observer.current?.request()} />;
}

function DefaultBrowserRow({ status, onSet }: { status?: DefaultBrowserStatus; onSet(): void }) {
  if (!status?.supported) return null;
  return (
    <section className="prefs-section">
      <h2>默认浏览器</h2>
      {status.isDefault ? (
        <p className="prefs-label">Pilion 是默认浏览器</p>
      ) : (
        <button className="secondary-button" onClick={onSet}>
          设为默认浏览器
        </button>
      )}
    </section>
  );
}

function UpdateSection({
  settings,
  update,
  save,
  run,
}: {
  settings: AppSettings;
  update?: UpdateState;
  save(patch: AppSettingsPatch): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const status: UpdateStatus = update?.status ?? { kind: 'unsupported' };
  const button = updateButton(status);
  return (
    <section className="prefs-section">
      <h2>更新</h2>
      {update && <p className="prefs-update-version">{`当前版本 ${update.currentVersion}`}</p>}
      <label className="prefs-option">
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(event) => save({ autoUpdate: event.target.checked })}
        />
        <span>
          <strong>自动更新</strong>
          <small>启动时和每 4 小时检查一次，下载好后提示重启。</small>
        </span>
      </label>
      <div className="prefs-update-status">
        <span>{updateStatusText(status)}</span>
        <span className="visually-hidden" role="status" aria-atomic="true">
          {updateStatusAnnouncement(status.kind)}
        </span>
        {button && (
          <button
            className="secondary-button"
            disabled={button.disabled}
            onClick={() =>
              void run(() =>
                button.action === 'install'
                  ? window.pilion.updates.install()
                  : window.pilion.updates.check(),
              )
            }
          >
            {button.label}
          </button>
        )}
      </div>
    </section>
  );
}

function BrowserPane({
  settings,
  downloadLocation,
  run,
}: {
  settings: AppSettings;
  downloadLocation: string;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const [selection, setSelection] = useState<BrowsingDataClearInput>({
    history: true,
    downloads: false,
    cookies: false,
    cache: true,
  });
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const perform = async (action: () => Promise<unknown>) => {
    setResult('');
    setBusy(true);
    try {
      await run(action);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="prefs-section">
        <h2>下载</h2>
        <span className="prefs-label">下载位置</span>
        <p className="prefs-update-version" title={settings.downloadDirectory}>
          {downloadLocation}
        </p>
        <div className="prefs-update-status">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void perform(() => window.pilion.downloads.chooseDirectory())}
          >
            更改…
          </button>
          {settings.downloadDirectory && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void perform(() => window.pilion.downloads.resetDirectory())}
            >
              恢复默认
            </button>
          )}
        </div>
      </section>
      <section className="prefs-section">
        <h2>清除浏览数据</h2>
        <p className="prefs-update-version">时间范围：全部</p>
        {(
          [
            { key: 'history', label: '浏览记录' },
            { key: 'downloads', label: '下载记录', detail: '只清除列表，不删除文件。' },
            { key: 'cookies', label: 'Cookie 和网站数据' },
            { key: 'cache', label: '缓存的图片和文件' },
          ] as const
        ).map((option) => (
          <label className="prefs-option" key={option.key}>
            <input
              type="checkbox"
              checked={selection[option.key]}
              disabled={busy}
              onChange={(event) => {
                setSelection((current) => ({ ...current, [option.key]: event.target.checked }));
                setResult('');
              }}
            />
            <span>
              <strong>{option.label}</strong>
              {'detail' in option && <small>{option.detail}</small>}
            </span>
          </label>
        ))}
        <div className="prefs-update-status">
          <span role="status">{result}</span>
          <button
            className="secondary-button"
            disabled={busy || !Object.values(selection).some(Boolean)}
            onClick={() =>
              void perform(async () => {
                const response = await window.pilion.browsingData.clear(selection);
                setResult(response.cleared ? '已清除' : '已取消');
              })
            }
          >
            清除…
          </button>
        </div>
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

const WEEKDAY_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
] as const;

type RuleKind = 'interval' | 'daily' | 'weekdays' | 'cron';

function buildRule(state: {
  kind: RuleKind;
  every: number;
  unit: 'minute' | 'hour';
  time: string;
  days: number[];
  expr: string;
}): ScheduleRule {
  if (state.kind === 'interval') return { kind: 'interval', every: state.every, unit: state.unit };
  if (state.kind === 'daily') return { kind: 'daily', time: state.time };
  if (state.kind === 'weekdays') return { kind: 'weekdays', days: state.days, time: state.time };
  return { kind: 'cron', expr: state.expr };
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function SchedulesPane({
  state,
  run,
}: {
  state: AppState;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const schedules = state.schedules ?? [];
  const agents = state.agents ?? [];
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<RuleKind>('daily');
  const [every, setEvery] = useState(30);
  const [unit, setUnit] = useState<'minute' | 'hour'>('minute');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [expr, setExpr] = useState('0 9 * * 1-5');
  const [preview, setPreview] = useState<string[]>([]);

  const ruleForm = { kind, every, unit, time, days, expr };
  const effectiveAgentId = agentId || agents[0]?.id || '';

  const refreshPreview = async (next: typeof ruleForm) => {
    try {
      const built = buildRule(next);
      setPreview(await window.pilion.schedules.preview(built));
    } catch {
      setPreview([]);
    }
  };

  const save = async () => {
    const input: ScheduleInput = {
      name: name.trim(),
      agentId: effectiveAgentId,
      prompt: prompt.trim(),
      rule: buildRule(ruleForm),
      enabled: true,
    };
    const ok = await run(() => window.pilion.schedules.save(input));
    if (ok) {
      setName('');
      setPrompt('');
    }
  };

  return (
    <>
      <section className="prefs-section">
        <h2>已有的定时任务</h2>
        {schedules.length === 0 && <p className="prefs-update-version">还没有定时任务。</p>}
        {schedules.map((item) => (
          <label className="prefs-option" key={item.id}>
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(event) =>
                void run(() => window.pilion.schedules.setEnabled(item.id, event.target.checked))
              }
            />
            <span>
              <strong>
                {item.name}
                {item.origin.kind === 'agent' ? '（Agent 创建）' : ''}
              </strong>
              <small>
                {describeRule(item.rule)} · 下次 {formatWhen(item.nextRunAt)}
                {item.lastOutcome
                  ? ` · 上次${item.lastOutcome.status === 'ok' ? '成功' : item.lastOutcome.status === 'skipped' ? '跳过' : '失败'}`
                  : ''}
              </small>
            </span>
            <span className="prefs-update-status">
              <button
                className="secondary-button"
                onClick={() => void run(() => window.pilion.schedules.runNow(item.id))}
              >
                立即运行
              </button>
              <button
                className="secondary-button"
                onClick={() => void run(() => window.pilion.schedules.remove(item.id))}
              >
                删除
              </button>
            </span>
          </label>
        ))}
      </section>
      <section className="prefs-section">
        <h2>新建定时任务</h2>
        <label className="prefs-label" htmlFor="schedule-name">
          名称
        </label>
        <input
          id="schedule-name"
          className="prefs-select"
          value={name}
          placeholder="例如：每天汇总待办"
          onChange={(event) => setName(event.target.value)}
        />
        <label className="prefs-label" htmlFor="schedule-agent">
          绑定 Agent
        </label>
        <select
          id="schedule-agent"
          className="prefs-select"
          value={effectiveAgentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.length === 0 && <option value="">请先在 Agent 页配置</option>}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <label className="prefs-label" htmlFor="schedule-prompt">
          Prompt
        </label>
        <textarea
          id="schedule-prompt"
          className="prefs-select"
          rows={3}
          value={prompt}
          placeholder="到点要发给 Agent 的话，例如「用 browser.skills.play 运行技能 X 并汇报结果」"
          onChange={(event) => setPrompt(event.target.value)}
        />
        <label className="prefs-label" htmlFor="schedule-kind">
          触发规则
        </label>
        <select
          id="schedule-kind"
          className="prefs-select"
          value={kind}
          onChange={(event) => {
            const next = { ...ruleForm, kind: event.target.value as RuleKind };
            setKind(next.kind);
            void refreshPreview(next);
          }}
        >
          <option value="daily">每天定点</option>
          <option value="weekdays">指定星期</option>
          <option value="interval">按间隔</option>
          <option value="cron">cron 表达式</option>
        </select>
        {kind === 'interval' && (
          <div className="prefs-update-status">
            <input
              type="number"
              className="prefs-select"
              min={1}
              value={every}
              onChange={(event) => {
                const next = { ...ruleForm, every: Number(event.target.value) };
                setEvery(next.every);
                void refreshPreview(next);
              }}
            />
            <select
              className="prefs-select"
              value={unit}
              onChange={(event) => {
                const next = { ...ruleForm, unit: event.target.value as 'minute' | 'hour' };
                setUnit(next.unit);
                void refreshPreview(next);
              }}
            >
              <option value="minute">分钟（最小 10）</option>
              <option value="hour">小时</option>
            </select>
          </div>
        )}
        {(kind === 'daily' || kind === 'weekdays') && (
          <input
            type="time"
            className="prefs-select"
            value={time}
            onChange={(event) => {
              const next = { ...ruleForm, time: event.target.value };
              setTime(next.time);
              void refreshPreview(next);
            }}
          />
        )}
        {kind === 'weekdays' && (
          <div className="prefs-update-status">
            {WEEKDAY_OPTIONS.map((day) => (
              <label key={day.value} className="prefs-option">
                <input
                  type="checkbox"
                  checked={days.includes(day.value)}
                  onChange={() => {
                    const toggled = days.includes(day.value)
                      ? days.filter((item) => item !== day.value)
                      : [...days, day.value];
                    const next = { ...ruleForm, days: toggled };
                    setDays(toggled);
                    void refreshPreview(next);
                  }}
                />
                <span>{day.label}</span>
              </label>
            ))}
          </div>
        )}
        {kind === 'cron' && (
          <input
            className="prefs-select"
            value={expr}
            placeholder="分 时 日 月 周，例如 0 9 * * 1-5"
            onChange={(event) => {
              const next = { ...ruleForm, expr: event.target.value };
              setExpr(next.expr);
              void refreshPreview(next);
            }}
          />
        )}
        {preview.length > 0 && (
          <p className="prefs-update-version">接下来三次：{preview.map(formatWhen).join('、')}</p>
        )}
        <div className="prefs-update-status">
          <button className="secondary-button" onClick={() => void save()}>
            保存定时任务
          </button>
        </div>
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
