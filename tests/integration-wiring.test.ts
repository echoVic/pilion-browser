import { describe, expect, it, vi } from 'vitest';
import type { AgentIntegration } from '../src/main/external/agent-integration.js';
import {
  INTEGRATION_CLIENT_NAME,
  integrationController,
} from '../src/main/external/integration-wiring.js';

type Issue = () => Promise<{ clientId: string; token: string }>;
type Rollback = (clientId: string) => Promise<void>;

function fakeIntegration(state: { clientId?: string; failAfterIssue?: boolean }) {
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
    install: vi.fn(async (issue: Issue, rollback: Rollback) => {
      const issued = await issue();
      if (state.failAfterIssue) {
        await rollback(issued.clientId);
        throw new Error('skill copy failed');
      }
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

function deps(
  state: { clientId?: string; failAfterIssue?: boolean },
  platform: NodeJS.Platform = 'darwin',
) {
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
  const revokeOffline = vi.fn<(clientId: string) => Promise<void>>(async () => undefined);
  let listening = true;
  const controller = integrationController({
    platform,
    integration,
    enableExternal,
    server: () => (listening ? (server as never) : undefined),
    revokeOffline,
    startError: () => undefined,
    audit,
  });
  const stopServer = () => {
    listening = false;
  };
  return { controller, integration, server, audit, enableExternal, revokeOffline, stopServer };
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

  it('re-install revokes the previous integration client only after the new one is in place', async () => {
    const d = deps({ clientId: 'old1' });
    await d.controller.install();
    expect(d.server.revokeClient).toHaveBeenCalledWith('old1');
    expect(d.server.createClient.mock.invocationCallOrder[0]).toBeLessThan(
      d.server.revokeClient.mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(d.integration.install).mock.invocationCallOrder[0]).toBeLessThan(
      d.server.revokeClient.mock.invocationCallOrder[0]!,
    );
  });

  it('re-install keeps the previous client when creating the new one fails', async () => {
    const d = deps({ clientId: 'old1' });
    d.server.createClient.mockRejectedValueOnce(new Error('registry write failed'));
    await expect(d.controller.install()).rejects.toThrow('registry write failed');
    expect(d.server.revokeClient).not.toHaveBeenCalled();
  });

  it('a failed install revokes the new client through the rollback and keeps the previous one', async () => {
    const d = deps({ clientId: 'old1', failAfterIssue: true });
    await expect(d.controller.install()).rejects.toThrow('skill copy failed');
    expect(d.server.revokeClient.mock.calls).toEqual([['new1']]);
    expect((await d.controller.status()).clientId).toBe('old1');
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

  it('remove with the channel off still revokes the client in the on-disk registry', async () => {
    const d = deps({ clientId: 'old1' });
    d.stopServer();
    await d.controller.remove();
    expect(d.server.revokeClient).not.toHaveBeenCalled();
    expect(d.revokeOffline).toHaveBeenCalledWith('old1');
  });

  it('operations run one at a time: a remove issued mid-install sees the new install', async () => {
    const d = deps({});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    d.server.createClient.mockImplementationOnce(async () => {
      await gate;
      return { client: { clientId: 'new1' }, token: 'pct_new1_secret', config: {} };
    });
    const installing = d.controller.install();
    // 让 install 先跑到 createClient 上卡住，再并发发起 remove 与 status。
    await vi.waitFor(() => expect(d.server.createClient).toHaveBeenCalledOnce());
    const removing = d.controller.remove();
    const reading = d.controller.status();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(d.integration.remove).not.toHaveBeenCalled();
    release();
    expect((await installing).installed).toBe(true);
    expect((await removing).installed).toBe(false);
    expect(d.server.revokeClient).toHaveBeenCalledWith('new1');
    // status 排在 remove 之后，读到的是移除后的状态，而不是安装一半的状态。
    expect((await reading).installed).toBe(false);
  });

  it('a failed operation does not block the ones queued after it', async () => {
    const d = deps({});
    d.server.createClient.mockRejectedValueOnce(new Error('boom'));
    const failing = d.controller.install();
    const next = d.controller.status();
    await expect(failing).rejects.toThrow('boom');
    expect((await next).supported).toBe(true);
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

  it('install fails clearly when the server did not start, with the start error', async () => {
    const d = deps({});
    const controller = integrationController({
      platform: 'darwin',
      integration: d.integration,
      enableExternal: async () => undefined,
      server: () => undefined,
      revokeOffline: async () => undefined,
      startError: () => '外部 socket 路径已被非 socket 占用：/x/external.sock',
      audit: () => undefined,
    });
    await expect(controller.install()).rejects.toThrow(
      '外部控制通道未启动，无法签发凭证：外部 socket 路径已被非 socket 占用：/x/external.sock',
    );
  });
});
