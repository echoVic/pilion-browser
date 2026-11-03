import type { AgentIntegrationView } from '../../shared/contracts.js';
import type { AgentIntegration } from './agent-integration.js';
import type { ExternalControlServer } from './server.js';

export const INTEGRATION_CLIENT_NAME = '本机 Agent（CLI）';

export interface IntegrationDeps {
  platform: NodeJS.Platform;
  integration: AgentIntegration;
  enableExternal(): Promise<void>;
  server(): Pick<ExternalControlServer, 'createClient' | 'revokeClient'> | undefined;
  audit(type: string, payload: Record<string, unknown>): void;
}

/** 「安装到 Agent」的主进程编排：签发/吊销客户端在 server，本机文件在 AgentIntegration。 */
export function integrationController(deps: IntegrationDeps) {
  const supported = deps.platform !== 'win32';

  async function status(): Promise<AgentIntegrationView> {
    const s = await deps.integration.status();
    return { supported, ...s };
  }

  async function install(): Promise<AgentIntegrationView> {
    if (!supported) throw new Error('Windows 暂不支持外部通道');
    await deps.enableExternal();
    const server = deps.server();
    if (!server) throw new Error('外部控制通道未启动，无法签发凭证');
    const previous = (await deps.integration.readState())?.clientId;
    const state = await deps.integration.install(async () => {
      if (previous) await server.revokeClient(previous);
      const created = await server.createClient(INTEGRATION_CLIENT_NAME, 'agent-integration');
      return { clientId: created.client.clientId, token: created.token };
    });
    deps.audit('external.integration.installed', {
      clientId: state.clientId,
      ...(previous ? { replaced: previous } : {}),
      targets: (state.targets ?? []).map((t) => `${t.agent}:${t.status}`),
    });
    return status();
  }

  async function remove(): Promise<AgentIntegrationView> {
    const clientId = await deps.integration.remove();
    if (clientId) {
      await deps.server()?.revokeClient(clientId);
      deps.audit('external.integration.removed', { clientId, reason: 'user' });
    }
    return status();
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

  return { status, install, remove, onClientGone, reconcile };
}
