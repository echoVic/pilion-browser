import { contextBridge, ipcRenderer } from 'electron';
import type { AgentConfig, AppState } from '../shared/contracts.js';
import { IPC } from '../shared/contracts.js';

const api = Object.freeze({
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.getState),
  onState: (fn: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => fn(state);
    ipcRenderer.on(IPC.state, listener);
    return () => { ipcRenderer.removeListener(IPC.state, listener); };
  },
  tabs: Object.freeze({
    open: (url?: string) => ipcRenderer.invoke(IPC.tabOpen, { url }),
    activate: (id: string) => ipcRenderer.invoke(IPC.tabActivate, { id }),
    close: (id: string) => ipcRenderer.invoke(IPC.tabClose, { id }),
    navigate: (url: string) => ipcRenderer.invoke(IPC.tabNavigate, { url }),
    back: () => ipcRenderer.invoke(IPC.tabBack),
    forward: () => ipcRenderer.invoke(IPC.tabForward),
    reload: () => ipcRenderer.invoke(IPC.tabReload),
  }),
  agents: Object.freeze({
    save: (config: AgentConfig) => ipcRenderer.invoke(IPC.agentSave, config),
    connect: (id: string) => ipcRenderer.invoke(IPC.agentConnect, { id }),
    disconnect: () => ipcRenderer.invoke(IPC.agentDisconnect),
    attach: () => ipcRenderer.invoke(IPC.agentAttach),
    detach: () => ipcRenderer.invoke(IPC.agentDetach),
    task: (text: string) => ipcRenderer.invoke(IPC.agentTask, { text }),
    cancel: () => ipcRenderer.invoke(IPC.agentCancel),
  }),
});
contextBridge.exposeInMainWorld('pilion', api);
export type PilionApi = typeof api;
