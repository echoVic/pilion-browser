import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { IPC } from '../src/shared/contracts';
import type { PilionApi } from '../src/preload/index';

/** Runs one preload file against a fake electron and records every `ipcRenderer.invoke`. */
function loadPreload(file: string, reply: (channel: unknown) => unknown = () => undefined) {
  let api: PilionApi | undefined;
  const calls: unknown[][] = [];
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(`../src/preload/${file}`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: {},
      require: (name: string) =>
        name === 'electron'
          ? {
              contextBridge: {
                exposeInMainWorld: (_name: string, bridge: PilionApi) => {
                  api = bridge;
                },
              },
              ipcRenderer: {
                on() {},
                invoke: async (...args: unknown[]) => {
                  calls.push(args);
                  return reply(args[0]);
                },
              },
            }
          : { IPC },
    },
  );
  expect(api).toBeDefined();
  return { api: api!, calls };
}

it.each(['index.ts', 'entry.cts'])(
  'preserves the originating conversation across every agent control in %s',
  async (file) => {
    const { api, calls } = loadPreload(file);
    const conversationId = 'conversation-a';
    await api.agents.attach(conversationId);
    await api.agents.detach(conversationId);
    await api.agents.task('original draft', undefined, conversationId);
    await api.agents.cancel(conversationId);
    await api.agents.takeOver(conversationId);
    await api.agents.resume('continue original', conversationId);
    // 权限模式按对话保存，切换时必须带上是哪个对话。
    await api.agents.setMode('ask', conversationId);
    await api.agents.retryConversation(conversationId);
    await api.agents.useAgentForConversation(conversationId, 'agent-b');
    expect(calls).toEqual([
      [IPC.agentAttach, { conversationId }],
      [IPC.agentDetach, { conversationId }],
      [IPC.agentTask, { text: 'original draft', attachments: undefined, conversationId }],
      [IPC.agentCancel, { conversationId }],
      [IPC.agentTakeOver, { conversationId }],
      [IPC.agentResume, { text: 'continue original', conversationId }],
      [IPC.agentSetMode, { mode: 'ask', conversationId }],
      [IPC.retryConversation, { id: conversationId }],
      [IPC.useAgentForConversation, { conversationId, agentId: 'agent-b' }],
    ]);
  },
);

it.each(['index.ts', 'entry.cts'])(
  'answers an approval with the gesture token it was just issued in %s',
  async (file) => {
    const issued = 'issued-by-main';
    const { api, calls } = loadPreload(file, (channel) =>
      channel === IPC.approvalGesture ? issued : undefined,
    );
    const approval = { approvalId: 'approval-1', nonce: 'nonce', actionDigest: 'digest' };
    await api.agents.approve(
      approval.approvalId,
      approval.nonce,
      approval.actionDigest,
      'approve',
      'space',
    );
    await api.agents.approve(approval.approvalId, approval.nonce, approval.actionDigest, 'deny');
    await api.agents.setModel('model-x');
    expect(calls).toEqual([
      [IPC.approvalGesture, approval],
      [
        IPC.approvalRespond,
        { ...approval, decision: 'approve', scope: 'space', gestureToken: issued },
      ],
      [IPC.approvalGesture, approval],
      [IPC.approvalRespond, { ...approval, decision: 'deny', gestureToken: issued }],
      [IPC.agentSetModel, { id: 'model-x' }],
    ]);
  },
);
