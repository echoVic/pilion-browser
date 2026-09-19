import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Download,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import type { AppState } from '../shared/contracts';
import {
  LOCAL_AGENTS,
  type LocalAgentEnvironment,
  type LocalAgentPreset,
} from '../shared/local-agents';
import { IconButton, statusCopy } from './ui';

export function LocalAgentSettings({
  state,
  initialPreset,
  close,
  run,
}: {
  state: AppState;
  initialPreset?: LocalAgentPreset;
  close(): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const initial =
    initialPreset ??
    state.agents.find((item) => item.id === state.connectedAgentId)?.preset ??
    state.agents.find((item) => item.preset)?.preset ??
    'claude';
  const saved = state.agents.find((item) => item.preset === initial);
  const [preset, setPreset] = useState<LocalAgentPreset>(initial);
  const [nodePath, setNodePath] = useState(saved?.nodePath ?? '');
  const [cwd, setCwd] = useState(saved?.cwd ?? '');
  const [environment, setEnvironment] = useState<LocalAgentEnvironment>();
  const [detecting, setDetecting] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const connected = state.connectedAgentId === `local:${preset}`;
  const busy = pending || ['starting', 'running', 'stopping'].includes(state.agentStatus);
  const agent = environment?.agents.find((item) => item.id === preset);
  const metadata = LOCAL_AGENTS.find((item) => item.id === preset)!;
  useEffect(() => {
    if (!window.pilion) return;
    let active = true;
    const timer = setTimeout(() => {
      setDetecting(true);
      void window.pilion.agents
        .inspectLocal(nodePath || undefined)
        .then((result) => {
          if (active) {
            setEnvironment(result);
            setError('');
          }
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        })
        .finally(() => {
          if (active) setDetecting(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [nodePath]);
  function select(id: LocalAgentPreset) {
    const config = state.agents.find((item) => item.preset === id);
    setPreset(id);
    setNodePath(config?.nodePath ?? nodePath);
    setCwd(config?.cwd ?? cwd);
    setError('');
  }
  async function connect() {
    if (busy || !window.pilion) return;
    setPending(true);
    try {
      await run(async () => {
        const config = await window.pilion.agents.configureLocal({
          preset,
          nodePath: nodePath || undefined,
          cwd: cwd || undefined,
        });
        await window.pilion.agents.connect(config.id);
        close();
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="local-agent-settings">
      <div className="local-setting-row">
        <label htmlFor="local-agent-choice">本地 Agent</label>
        <select
          id="local-agent-choice"
          value={preset}
          disabled={busy}
          onChange={(event) => select(event.target.value as LocalAgentPreset)}
        >
          {LOCAL_AGENTS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="local-runtime-status" aria-live="polite">
        {detecting ? (
          <LoaderCircle size={16} className="spin" />
        ) : connected || agent?.status === 'ready' ? (
          <Check size={16} />
        ) : (
          <Download size={16} />
        )}
        <div>
          <strong>
            {connected
              ? statusCopy[state.agentStatus]
              : !window.pilion
                ? '等待桌面环境检测'
                : detecting
                  ? '正在检测本机环境'
                  : agent?.status === 'cli_missing'
                    ? '需要安装官方 CLI'
                    : agent?.error
                      ? 'Node.js 需要配置'
                      : agent?.status === 'ready'
                        ? '已检测到 ACP 程序'
                        : agent?.cliPath
                          ? '已检测到本机 CLI，ACP 适配器待安装'
                          : agent?.status === 'runtime_missing'
                            ? '未找到可用的 Node.js / npx'
                            : '首次连接需要安装 ACP'}
          </strong>
          <span>
            {metadata.name} · {metadata.executable}
          </span>
        </div>
        <IconButton
          label="重新检测本机环境"
          disabled={detecting || busy || !window.pilion}
          onClick={async () => {
            setDetecting(true);
            try {
              setEnvironment(await window.pilion.agents.inspectLocal(nodePath || undefined));
            } catch (cause) {
              setError(String(cause));
            } finally {
              setDetecting(false);
            }
          }}
        >
          <RefreshCw size={15} />
        </IconButton>
      </div>
      <div className="local-setting-field">
        <label htmlFor="local-node-path">
          Node.js 路径 <span>{environment?.nodeVersion}</span>
        </label>
        <input
          id="local-node-path"
          value={nodePath}
          disabled={busy || connected}
          placeholder={environment?.nodePath ?? '自动检测'}
          onChange={(event) => setNodePath(event.target.value)}
        />
      </div>
      <div className="local-setting-field">
        <label htmlFor="local-working-directory">工作目录</label>
        <div className="path-picker">
          <input
            id="local-working-directory"
            value={cwd}
            disabled={busy || connected}
            placeholder={environment?.defaultCwd ?? '默认工作目录'}
            onChange={(event) => setCwd(event.target.value)}
          />
          <IconButton
            label="选择工作目录"
            disabled={busy || connected || !window.pilion}
            onClick={async () => {
              await run(async () => {
                const path = await window.pilion.agents.chooseDirectory();
                if (path) setCwd(path);
              });
            }}
          >
            <FolderOpen size={17} />
          </IconButton>
        </div>
      </div>
      {agent?.executablePath && (
        <div className="detected-path">
          <span>ACP 路径</span>
          <code>{agent.executablePath}</code>
        </div>
      )}
      {(error || agent?.error) && (
        <p className="form-error" role="alert">
          {error || agent?.error}
        </p>
      )}
      <footer className="local-agent-actions">
        <span>
          {connected
            ? '浏览器工作区已连接'
            : agent?.status === 'install_required'
              ? `${metadata.package} · 首次安装适配器可能需要几分钟`
              : '使用本机 Agent 认证'}
        </span>
        {connected ? (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void run(() => window.pilion.agents.disconnect())}
          >
            <Unplug size={15} />
            断开连接
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={
              busy ||
              detecting ||
              !environment ||
              Boolean(agent?.error) ||
              agent?.status === 'runtime_missing' ||
              agent?.status === 'cli_missing'
            }
            onClick={() => void connect()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : agent?.status === 'install_required' ? (
              <Download size={15} />
            ) : (
              <ArrowRight size={15} />
            )}
            {busy
              ? agent?.status === 'install_required'
                ? '正在安装并连接…'
                : '正在连接'
              : agent?.status === 'install_required'
                ? '安装并连接'
                : '连接'}
          </button>
        )}
      </footer>
    </section>
  );
}
