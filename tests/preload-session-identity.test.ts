import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { IPC } from '../src/shared/contracts';
import type { PilionApi } from '../src/preload/index';

it.each(['index.ts', 'entry.cts'])(
  'preserves the originating conversation across every agent control in %s',
  async (file) => {
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
                  },
                },
              }
            : { IPC },
      },
    );
    expect(api).toBeDefined();
    const conversationId = 'conversation-a';
    await api!.agents.attach(conversationId);
    await api!.agents.detach(conversationId);
    await api!.agents.task('original draft', undefined, conversationId);
    await api!.agents.cancel(conversationId);
    await api!.agents.takeOver(conversationId);
    await api!.agents.resume('continue original', conversationId);
    expect(calls).toEqual([
      [IPC.agentAttach, { conversationId }],
      [IPC.agentDetach, { conversationId }],
      [IPC.agentTask, { text: 'original draft', attachments: undefined, conversationId }],
      [IPC.agentCancel, { conversationId }],
      [IPC.agentTakeOver, { conversationId }],
      [IPC.agentResume, { text: 'continue original', conversationId }],
    ]);
  },
);
