import { describe, expect, it, vi } from 'vitest';
import type { AgentIntegration } from '../src/main/external/agent-integration.js';
import {
  INTEGRATION_CLIENT_NAME,
  integrationController,
} from '../src/main/external/integration-wiring.js';

function fakeIntegration(state: { clientId?: string }) {
  return {
    status: vi.fn(async () => ({
      installed: Boolean(state.clientId),
      ...(state.clientId ? { clientId: state.clientId } : {}),
      shimPath: '/h/.local/bin/pilion',
      shimConflict: false,
      pathHasShimDir: true,
      targets: [],
    })),
    readState: vi.fn(async () => (state.clientId ? { clientId: state.clientId } : undefined)),
    install: vi.fn(async (issue: () => Promise<{ clientId: string; token: string }>) => {
      const issued = await issue();
      state.clientId = issued.clientId;
      return { clientId: issued.clientId };
    }),
    remove: vi.fn(async () => {
      const id = state.clientId;
      state.clientId = undefined;
      return id;
    }),
    reconcile: vi.fn(async () => undefined),
  } as unknown as AgentIntegration & Record<string, ReturnType<typeof vi.fn>>;
}

function deps(state: { clientId?: string }, platform: NodeJS.Platform = 'darwin') {
  const integration = fakeIntegration(state);
  const server = {
    createClient: vi.fn(async () => ({
      client: { clientId: 'new1' },
      token: 'pct_new1_s',
      config: {},
    })),
    revokeClient: vi.fn(async () => undefined),
  };
  const audit = vi.fn();
  const enableExternal = vi.fn(async () => undefined);
  const controller = integrationController({
    platform,
    integration,
    enableExternal,
    server: () => server as never,
    audit,
  });
  return { controller, integration, server, audit, enableExternal };
}

describe('integrationController', () => {
  it('install enables the channel, issues a kind=agent-integration client and audits', async () => {
    const d = deps({});
    const view = await d.controller.install();
    expect(d.enableExternal).toHaveBeenCalledOnce();
    expect(d.server.createClient).toHaveBeenCalledWith(
      INTEGRATION_CLIENT_NAME,
      'agent-integration',
    );
    expect(view).toMatchObject({ supported: true, installed: true, clientId: 'new1' });
    expect(d.audit).toHaveBeenCalledWith(
      'external.integration.installed',
      expect.objectContaining({ clientId: 'new1' }),
    );
  });

  it('re-install revokes the previous integration client first', async () => {
    const d = deps({ clientId: 'old1' });
    await d.controller.install();
    expect(d.server.revokeClient).toHaveBeenCalledWith('old1');
  });

  it('remove revokes the client and removes local files', async () => {
    const d = deps({ clientId: 'old1' });
    const view = await d.controller.remove();
    expect(d.integration.remove).toHaveBeenCalledOnce();
    expect(d.server.revokeClient).toHaveBeenCalledWith('old1');
    expect(view.installed).toBe(false);
    expect(d.audit).toHaveBeenCalledWith('external.integration.removed', {
      clientId: 'old1',
      reason: 'user',
    });
  });

  it('onClientGone cleans up only for the integration client', async () => {
    const d = deps({ clientId: 'int1' });
    await d.controller.onClientGone('someone-else');
    expect(d.integration.remove).not.toHaveBeenCalled();
    await d.controller.onClientGone('int1');
    expect(d.integration.remove).toHaveBeenCalledOnce();
    expect(d.server.revokeClient).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith('external.integration.removed', {
      clientId: 'int1',
      reason: 'client-revoked',
    });
  });

  it('is unsupported on win32: status says so and install throws', async () => {
    const d = deps({}, 'win32');
    expect((await d.controller.status()).supported).toBe(false);
    await expect(d.controller.install()).rejects.toThrow('Windows 暂不支持外部通道');
    await d.controller.reconcile();
    expect(d.integration.reconcile).not.toHaveBeenCalled();
  });

  it('install fails clearly when the server did not start', async () => {
    const d = deps({});
    const controller = integrationController({
      platform: 'darwin',
      integration: d.integration,
      enableExternal: async () => undefined,
      server: () => undefined,
      audit: () => undefined,
    });
    await expect(controller.install()).rejects.toThrow(/外部控制通道未启动/);
  });
});
