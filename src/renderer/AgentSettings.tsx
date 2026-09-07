import { useState } from "react";
import {
  Check,
  ChevronLeft,
  Laptop,
  Pencil,
  Plus,
  Server,
  Terminal,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import type { AgentConfig, AppState } from "../shared/contracts";
import { IconButton, statusCopy } from "./ui";
import type { LocalAgentPreset } from '../shared/local-agents';
import { LocalAgentSettings } from './LocalAgentSettings';

type Draft = {
  id: string;
  name: string;
  transport: "stdio" | "ssh";
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
  id: "",
  name: "",
  transport: "stdio",
  command: "",
  args: "[]",
  cwd: "",
  host: "",
  port: "22",
  identityFile: "",
  env: "{}",
  authMethodId: "",
};
export function AgentSettings({
  state,
  close,
  run,
  initialPreset,
}: {
  state: AppState;
  close(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
  initialPreset?: LocalAgentPreset;
}) {
  const [mode, setMode] = useState<'local' | 'custom'>('local');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  function change(key: keyof Draft, value: string) {
    setDraft((current) => current && { ...current, [key]: value });
  }
  function edit(config: AgentConfig) {
    setError("");
    setDraft({
      ...blank,
      ...config,
      transport: config.transport ?? "stdio",
      cwd: config.cwd ?? "",
      args: JSON.stringify(config.args),
      host: config.ssh?.host ?? "",
      port: String(config.ssh?.port ?? 22),
      identityFile: config.ssh?.identityFile ?? "",
      env: JSON.stringify(config.env ?? {}, null, 2),
      authMethodId: config.authMethodId ?? "",
    });
  }
  async function save(connect: boolean) {
    if (!draft) return;
    setError("");
    setSaving(true);
    try {
      const args: unknown = JSON.parse(draft.args);
      const env: unknown = JSON.parse(draft.env);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
        throw new Error("启动参数必须是 JSON 字符串数组");
      if (
        !env ||
        typeof env !== "object" ||
        Array.isArray(env) ||
        Object.entries(env).some(
          ([key, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string",
        )
      )
        throw new Error("环境变量必须是 JSON 字符串对象");
      if (
        draft.transport === "ssh" &&
        (!draft.cwd.startsWith("/") ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/.test(draft.host))
      )
        throw new Error("请输入有效的 SSH 主机和远端绝对工作目录");
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
          draft.transport === "ssh"
            ? {
                host: draft.host,
                port: Number(draft.port),
                identityFile: draft.identityFile || undefined,
              }
            : undefined,
      };
      if (!config.name || !config.command)
        throw new Error("请填写名称和启动命令");
      await window.pilion.agents.save(config);
      setDraft(null);
      if (connect && (await run(() => window.pilion.agents.connect(config.id))))
        close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  const busy = ["starting", "stopping", "running"].includes(state.agentStatus);
  return (
    <div className="settings-surface">
      <header className="surface-header">
        <div>
          <span className="eyebrow">工作区设置</span>
          <h1>Agent 连接</h1>
        </div>
        <IconButton label="关闭设置" onClick={close}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="segmented settings-mode"><button className={mode === 'local' ? 'selected' : ''} onClick={() => setMode('local')}><Laptop size={16} />本地 Agent</button><button className={mode === 'custom' ? 'selected' : ''} onClick={() => setMode('custom')}><Server size={16} />自定义 / 远端</button></div>
      {mode === 'local' ? <LocalAgentSettings key={initialPreset ?? 'local'} state={state} initialPreset={initialPreset} close={close} run={run} /> : draft ? (
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
              setError("");
            }}
          >
            <ChevronLeft size={15} />
            所有连接
          </button>
          <div className="segmented">
            <button
              type="button"
              className={draft.transport === "stdio" ? "selected" : ""}
              onClick={() => change("transport", "stdio")}
            >
              <Laptop size={16} />
              自定义命令
            </button>
            <button
              type="button"
              className={draft.transport === "ssh" ? "selected" : ""}
              onClick={() => change("transport", "ssh")}
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
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
          {draft.transport === "ssh" && (
            <div className="form-row">
              <label>
                SSH 主机
                <input
                  required
                  placeholder="user@host 或 SSH 别名"
                  value={draft.host}
                  onChange={(event) => change("host", event.target.value)}
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
                  onChange={(event) => change("port", event.target.value)}
                />
              </label>
            </div>
          )}
          <label>
            ACP 启动命令
            <input
              required
              placeholder="claude-agent-acp"
              value={draft.command}
              onChange={(event) => change("command", event.target.value)}
            />
          </label>
          <label>
            启动参数 <span>JSON 数组</span>
            <input
              className="mono"
              placeholder={'["--flag", "value with spaces"]'}
              value={draft.args}
              onChange={(event) => change("args", event.target.value)}
            />
          </label>
          <label>
            {draft.transport === "ssh" ? "远端工作目录" : "工作目录"}
            <input
              required={draft.transport === "ssh"}
              placeholder={
                draft.transport === "ssh"
                  ? "/home/user/workspace"
                  : "默认使用当前目录"
              }
              value={draft.cwd}
              onChange={(event) => change("cwd", event.target.value)}
            />
          </label>
          <details>
            <summary>高级设置</summary>
            <div className="advanced-fields">
              {draft.transport === "ssh" && (
                <label>
                  SSH 私钥路径
                  <input
                    placeholder="默认使用 SSH 配置与密钥"
                    value={draft.identityFile}
                    onChange={(event) =>
                      change("identityFile", event.target.value)
                    }
                  />
                </label>
              )}
              <label>
                环境变量 <span>JSON 对象</span>
                <textarea
                  className="mono"
                  rows={3}
                  value={draft.env}
                  onChange={(event) => change("env", event.target.value)}
                />
              </label>
              <label>
                认证方式 ID
                <input
                  placeholder="自动协商"
                  value={draft.authMethodId}
                  onChange={(event) =>
                    change("authMethodId", event.target.value)
                  }
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
            <button
              className="primary-button"
              disabled={saving || busy}
              type="submit"
            >
              <Check size={16} />
              保存并连接
            </button>
          </footer>
        </form>
      ) : (
        <div className="connections-list">
          {state.agents.filter(agent => !agent.preset).map((agent) => (
            <article className="connection-row" key={agent.id}>
              <span className="connection-icon">
                {agent.transport === "ssh" ? (
                  <Server size={21} />
                ) : (
                  <Terminal size={21} />
                )}
              </span>
              <div className="connection-description">
                <strong>{agent.name}</strong>
                <span>
                  {agent.transport === "ssh" ? agent.ssh?.host : "本地"} · ACP
                </span>
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
                      onClick={() =>
                        void run(() => window.pilion.agents.disconnect())
                      }
                    >
                      <Unplug size={16} />
                    </IconButton>
                  </>
                ) : (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        await run(() => window.pilion.agents.connect(agent.id))
                      )
                        close();
                    }}
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
                  onClick={() =>
                    void run(() => window.pilion.agents.remove(agent.id))
                  }
                >
                  <Trash2 size={15} />
                </IconButton>
              </div>
            </article>
          ))}
          {!state.agents.some(agent => !agent.preset) && (
            <div className="empty-list">
              <Terminal size={30} />
              <h2>还没有自定义连接</h2>
            </div>
          )}
          <button
            className="add-connection"
            onClick={() => {
              setDraft({ ...blank });
              setError("");
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
