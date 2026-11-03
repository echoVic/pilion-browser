import type { AgentIntegrationView } from '../../shared/contracts.js';
import type { AgentIntegration } from './agent-integration.js';
import type { ExternalControlServer } from './server.js';

export const INTEGRATION_CLIENT_NAME = '本机 Agent（CLI）';

export interface IntegrationDeps {
  platform: NodeJS.Platform;
  integration: AgentIntegration;
  enableExternal(): Promise<void>;
  server(): Pick<ExternalControlServer, 'createClient' | 'revokeClient'> | undefined;
  /** 通道没在监听时直接改磁盘上的客户端注册表吊销，保证「移除」后 token 再开通道也用不了。 */
  revokeOffline(clientId: string): Promise<void>;
  /** 外部通道最近一次启动失败的原因（没有就是 undefined），拼进「未启动」的报错里。 */
  startError(): string | undefined;
  audit(type: string, payload: Record<string, unknown>): void;
}

/** 「安装到 Agent」的主进程编排：签发/吊销客户端在 server，本机文件在 AgentIntegration。 */
export function integrationController(deps: IntegrationDeps) {
  const supported = deps.platform !== 'win32';
  /** 所有操作排成一队：安装、移除、对账、吊销清理与读状态互不交错，界面不会读到写了一半的状态。 */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op);
    queue = run.catch(() => undefined);
    return run;
  }

  async function view(): Promise<AgentIntegrationView> {
    const s = await deps.integration.status();
    return { supported, ...s };
  }

  async function revoke(clientId: string): Promise<void> {
    const server = deps.server();
    if (server) await server.revokeClient(clientId);
    else await deps.revokeOffline(clientId);
  }

  async function install(): Promise<AgentIntegrationView> {
    if (!supported) throw new Error('Windows 暂不支持外部通道');
    await deps.enableExternal();
    const server = deps.server();
    if (!server) {
      const reason = deps.startError();
      throw new Error(`外部控制通道未启动，无法签发凭证${reason ? `：${reason}` : ''}`);
    }
    const previous = (await deps.integration.readState())?.clientId;
    // 先签发新客户端、装好全部文件，成功后才吊销旧的；中途失败由 rollback 吊销新的，旧安装原样可用。
    const state = await deps.integration.install(
      async () => {
        const created = await server.createClient(INTEGRATION_CLIENT_NAME, 'agent-integration');
        return { clientId: created.client.clientId, token: created.token };
      },
      (clientId) => revoke(clientId),
    );
    if (previous && previous !== state.clientId) await revoke(previous);
    deps.audit('external.integration.installed', {
      clientId: state.clientId,
      ...(previous ? { replaced: previous } : {}),
      targets: (state.targets ?? []).map((t) => `${t.agent}:${t.status}`),
    });
    return view();
  }

  async function remove(): Promise<AgentIntegrationView> {
    const clientId = await deps.integration.remove();
    if (clientId) {
      await revoke(clientId);
      deps.audit('external.integration.removed', { clientId, reason: 'user' });
    }
    return view();
  }

  async function onClientGone(clientId: string): Promise<void> {
    const state = await deps.integration.readState();
    if (state?.clientId !== clientId) return;
    await deps.integration.remove();
    deps.audit('external.integration.removed', { clientId, reason: 'client-revoked' });
  }

  async function reconcile(): Promise<void> {
    if (!supported) return;
    await deps.integration.reconcile();
  }

  return {
    status: () => serial(view),
    install: () => serial(install),
    remove: () => serial(remove),
    onClientGone: (clientId: string) => serial(() => onClientGone(clientId)),
    reconcile: () => serial(reconcile),
  };
}
