import { useState } from 'react';
import clsx from 'clsx';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  Laptop,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
  Unplug,
} from 'lucide-react';
import type { AgentConfig, AppState } from '../shared/contracts';
import { IconButton, statusCopy } from './ui';
import type { LocalAgentPreset } from '../shared/local-agents';
import { LocalAgentSettings } from './LocalAgentSettings';

type Draft = {
  id: string;
  name: string;
  transport: 'stdio' | 'ssh';
  command: string;
  args: string;
  cwd: string;
  host: string;
  port: string;
  identityFile: string;
  env: string;
  authMethodId: string;
};
const blank: Draft = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  args: '[]',
  cwd: '',
  host: '',
  port: '22',
  identityFile: '',
  env: '{}',
  authMethodId: '',
};
type FieldErrors = {
  name?: boolean;
  command?: boolean;
  args?: boolean;
  env?: boolean;
  host?: boolean;
  cwd?: boolean;
};
/** 表单校验失败：携带面向用户的中文提示与出错字段，env 出错时要求展开高级设置。 */
class ValidationError extends Error {
  constructor(
    message: string,
    readonly fields: FieldErrors,
    readonly revealAdvanced = false,
  ) {
    super(message);
  }
}
/** 设置窗口 Agent 页里的连接管理：本地预设，加上自定义命令与 SSH 远端。 */
export function AgentSettings({
  state,
  run,
  initialPreset,
}: {
  state: AppState;
  run(action: () => Promise<unknown>): Promise<boolean>;
  initialPreset?: LocalAgentPreset;
}) {
  const [mode, setMode] = useState<'local' | 'custom'>('local');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  function change(key: keyof Draft, value: string) {
    setDraft((current) => current && { ...current, [key]: value });
    setFieldErrors((current) => {
      if (!current || !(key in current) || !current[key as keyof FieldErrors]) return current;
      return { ...current, [key]: false };
    });
  }
  function resetFormState() {
    setError('');
    setFieldErrors(null);
    setAdvancedOpen(false);
  }
  function edit(config: AgentConfig) {
    resetFormState();
    setDraft({
      ...blank,
      ...config,
      transport: config.transport ?? 'stdio',
      cwd: config.cwd ?? '',
      args: JSON.stringify(config.args),
      host: config.ssh?.host ?? '',
      port: String(config.ssh?.port ?? 22),
      identityFile: config.ssh?.identityFile ?? '',
      env: JSON.stringify(config.env ?? {}, null, 2),
      authMethodId: config.authMethodId ?? '',
    });
  }
  async function save(connect: boolean) {
    if (!draft) return;
    resetFormState();
    setSaving(true);
    try {
      let args: unknown;
      try {
        args = JSON.parse(draft.args);
      } catch {
        throw new ValidationError('启动参数必须是合法的 JSON 字符串数组', { args: true });
      }
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
        throw new ValidationError('启动参数必须是 JSON 字符串数组', { args: true });
      let env: unknown;
      try {
        env = JSON.parse(draft.env);
      } catch {
        throw new ValidationError('环境变量必须是合法的 JSON 字符串对象', { env: true }, true);
      }
      if (
        !env ||
        typeof env !== 'object' ||
        Array.isArray(env) ||
        Object.entries(env).some(
          ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string',
        )
      )
        throw new ValidationError('环境变量必须是 JSON 字符串对象', { env: true }, true);
      if (draft.transport === 'ssh') {
        const hostValid = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(draft.host);
        const cwdValid = draft.cwd.startsWith('/');
        if (!hostValid || !cwdValid)
          throw new ValidationError('请输入有效的 SSH 主机和远端绝对工作目录', {
            host: !hostValid,
            cwd: !cwdValid,
          });
      }
      const config: AgentConfig = {
        id: draft.id || crypto.randomUUID(),
        name: draft.name.trim(),
        command: draft.command.trim(),
        args: args as string[],
        cwd: draft.cwd.trim() || undefined,
        transport: draft.transport,
        enabled: true,
        env: env as Record<string, string>,
        authMethodId: draft.authMethodId.trim() || undefined,
        ssh:
          draft.transport === 'ssh'
            ? {
                host: draft.host,
                port: Number(draft.port),
                identityFile: draft.identityFile || undefined,
              }
            : undefined,
      };
      if (!config.name || !config.command)
        throw new ValidationError('请填写名称和启动命令', {
          name: !config.name,
          command: !config.command,
        });
      await window.pilion.agents.save(config);
      setDraft(null);
      if (connect) await run(() => window.pilion.agents.connect(config.id));
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setError(cause.message);
        setFieldErrors(cause.fields);
        if (cause.revealAdvanced) setAdvancedOpen(true);
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setSaving(false);
    }
  }
  const busy = ['starting', 'stopping', 'running'].includes(state.agentStatus);
  return (
    <div className="agent-connections">
      <div className="segmented settings-mode">
        <button className={clsx({ selected: mode === 'local' })} onClick={() => setMode('local')}>
          <Laptop size={16} />
          本地 Agent
        </button>
        <button className={clsx({ selected: mode === 'custom' })} onClick={() => setMode('custom')}>
          <Server size={16} />
          自定义 / 远端
        </button>
      </div>
      {mode === 'local' ? (
        <LocalAgentSettings
          key={initialPreset ?? 'local'}
          state={state}
          initialPreset={initialPreset}
          run={run}
        />
      ) : draft ? (
        <form
          className="agent-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save(true);
          }}
        >
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setDraft(null);
              resetFormState();
            }}
          >
            <ChevronLeft size={15} />
            所有连接
          </button>
          <div className="segmented">
            <button
              type="button"
              className={clsx({ selected: draft.transport === 'stdio' })}
              onClick={() => change('transport', 'stdio')}
            >
              <Laptop size={16} />
              自定义命令
            </button>
            <button
              type="button"
              className={clsx({ selected: draft.transport === 'ssh' })}
              onClick={() => change('transport', 'ssh')}
            >
              <Server size={16} />
              远端 SSH
            </button>
          </div>
          <label>
            名称
            <input
              autoFocus
              required
              placeholder="我的 Agent"
              className={fieldErrors?.name ? 'input-invalid' : undefined}
              aria-invalid={fieldErrors?.name ? true : undefined}
              value={draft.name}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          {draft.transport === 'ssh' && (
            <div className="form-row">
              <label>
                SSH 主机
                <input
                  required
                  placeholder="user@host 或 SSH 别名"
                  className={fieldErrors?.host ? 'input-invalid' : undefined}
                  aria-invalid={fieldErrors?.host ? true : undefined}
                  value={draft.host}
                  onChange={(event) => change('host', event.target.value)}
                />
              </label>
              <label className="port-field">
                端口
                <input
                  type="number"
                  min="1"
                  max="65535"
                  required
                  value={draft.port}
                  onChange={(event) => change('port', event.target.value)}
                />
              </label>
            </div>
          )}
          <label>
            ACP 启动命令
            <input
              required
              placeholder="claude-agent-acp"
              className={fieldErrors?.command ? 'input-invalid' : undefined}
              aria-invalid={fieldErrors?.command ? true : undefined}
              value={draft.command}
              onChange={(event) => change('command', event.target.value)}
            />
          </label>
          <label>
            启动参数 <span>JSON 数组</span>
            <input
              className={clsx('mono', { 'input-invalid': fieldErrors?.args })}
              aria-invalid={fieldErrors?.args ? true : undefined}
              placeholder={'["--flag", "value with spaces"]'}
              value={draft.args}
              onChange={(event) => change('args', event.target.value)}
            />
          </label>
          <label>
            {draft.transport === 'ssh' ? '远端工作目录' : '工作目录'}
            <input
              required={draft.transport === 'ssh'}
              placeholder={draft.transport === 'ssh' ? '/home/user/workspace' : '默认使用当前目录'}
              className={fieldErrors?.cwd ? 'input-invalid' : undefined}
              aria-invalid={fieldErrors?.cwd ? true : undefined}
              value={draft.cwd}
              onChange={(event) => change('cwd', event.target.value)}
            />
          </label>
          <details
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary>
              高级设置
              <ChevronDown size={13} />
            </summary>
            <div className="advanced-fields">
              {draft.transport === 'ssh' && (
                <label>
                  SSH 私钥路径
                  <input
                    placeholder="默认使用 SSH 配置与密钥"
                    value={draft.identityFile}
                    onChange={(event) => change('identityFile', event.target.value)}
                  />
                </label>
              )}
              <label>
                环境变量 <span>JSON 对象</span>
                <textarea
                  className={clsx('mono', { 'input-invalid': fieldErrors?.env })}
                  aria-invalid={fieldErrors?.env ? true : undefined}
                  rows={3}
                  value={draft.env}
                  onChange={(event) => change('env', event.target.value)}
                />
              </label>
              <label>
                认证方式 ID
                <input
                  placeholder="自动协商"
                  value={draft.authMethodId}
                  onChange={(event) => change('authMethodId', event.target.value)}
                />
              </label>
            </div>
          </details>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <footer className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => void save(false)}
            >
              保存
            </button>
            <button className="primary-button" disabled={saving || busy} type="submit">
              <Check size={16} />
              保存并连接
            </button>
          </footer>
        </form>
      ) : (
        <div className="connections-list">
          {state.agents
            .filter((agent) => !agent.preset)
            .map((agent) => (
              <article className="connection-row" key={agent.id}>
                <span className="connection-icon">
                  {agent.transport === 'ssh' ? <Server size={21} /> : <Terminal size={21} />}
                </span>
                <div className="connection-description">
                  <strong>{agent.name}</strong>
                  <span>{agent.transport === 'ssh' ? agent.ssh?.host : '本地'} · ACP</span>
                  <code>{agent.command}</code>
                </div>
                <div className="connection-actions">
                  {state.connectedAgentId === agent.id ? (
                    <>
                      <span className="status-label">
                        <i />
                        {statusCopy[state.agentStatus]}
                      </span>
                      <IconButton
                        label={`断开 ${agent.name}`}
                        disabled={busy}
                        onClick={() => void run(() => window.pilion.agents.disconnect())}
                      >
                        <Unplug size={16} />
                      </IconButton>
                    </>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void run(() => window.pilion.agents.connect(agent.id))}
                    >
                      连接
                    </button>
                  )}
                  <IconButton
                    label={`编辑 ${agent.name}`}
                    disabled={busy || state.connectedAgentId === agent.id}
                    onClick={() => edit(agent)}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label={`删除 ${agent.name}`}
                    disabled={state.connectedAgentId === agent.id}
                    onClick={() => void run(() => window.pilion.agents.remove(agent.id))}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </article>
            ))}
          {!state.agents.some((agent) => !agent.preset) && (
            <div className="empty-list">
              <Terminal size={26} />
              <h2>还没有自定义连接</h2>
              <p>添加一个通过 ACP 接入的命令行 Agent，让它在这个浏览器里替你操作网页。</p>
            </div>
          )}
          <button
            className="add-connection"
            onClick={() => {
              setDraft({ ...blank });
              resetFormState();
            }}
          >
            <Plus size={17} />
            添加 Agent
          </button>
        </div>
      )}
    </div>
  );
}
