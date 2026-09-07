import { contextBridge, ipcRenderer } from 'electron';
import type { AgentConfig, AppState, BrowserViewport, PermissionMode } from '../shared/contracts.js';
import type { LocalAgentEnvironment, LocalAgentInput } from '../shared/local-agents.js';

const IPC = {
  getState: 'app:get-state', state: 'app:state', tabOpen: 'tabs:open', tabActivate: 'tabs:activate',
  tabClose: 'tabs:close', tabNavigate: 'tabs:navigate', tabBack: 'tabs:back', tabForward: 'tabs:forward',
  tabReload: 'tabs:reload', agentSave: 'agents:save', agentConnect: 'agents:connect',
  agentDisconnect: 'agents:disconnect', agentAttach: 'agents:attach', agentDetach: 'agents:detach',
  agentTask: 'agents:task', agentCancel: 'agents:cancel',
} as const;
const api = Object.freeze({
  onShortcut: (fn: (key: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, key: string) => fn(key);
    ipcRenderer.on('app:shortcut', listener);
    return () => { ipcRenderer.removeListener('app:shortcut', listener); };
  },
  viewport: (bounds: BrowserViewport) => ipcRenderer.invoke('browser:viewport', bounds),
  workspace: Object.freeze({
    copyMessage: (id: string) => ipcRenderer.invoke('workspace:copy-message', { id }),
    newConversation: () => ipcRenderer.invoke('conversation:new'),
    selectConversation: (id: string) => ipcRenderer.invoke('conversation:select', { id }),
    toggleBookmark: () => ipcRenderer.invoke('bookmark:toggle'),
    clearHistory: () => ipcRenderer.invoke('history:clear'),
  }),
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.getState),
  onState: (fn: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => fn(state);
    ipcRenderer.on(IPC.state, listener);
    return () => { ipcRenderer.removeListener(IPC.state, listener); };
  },
  tabs: Object.freeze({
    open: (url?: string) => ipcRenderer.invoke(IPC.tabOpen, { url }), activate: (id: string) => ipcRenderer.invoke(IPC.tabActivate, { id }),
    close: (id: string) => ipcRenderer.invoke(IPC.tabClose, { id }), navigate: (url: string) => ipcRenderer.invoke(IPC.tabNavigate, { url }),
    back: () => ipcRenderer.invoke(IPC.tabBack), forward: () => ipcRenderer.invoke(IPC.tabForward), reload: () => ipcRenderer.invoke(IPC.tabReload),
  }),
  agents: Object.freeze({
    approve: async (approvalId: string, nonce: string, actionDigest: string, decision: 'approve' | 'deny') => { const gestureToken = await ipcRenderer.invoke('approval:gesture', { approvalId, nonce, actionDigest }); return ipcRenderer.invoke('approval:respond', { approvalId, nonce, actionDigest, decision, gestureToken }); },
    setMode: (mode: PermissionMode) => ipcRenderer.invoke('agents:set-mode', { mode }),
    setModel: (modelId: string) => ipcRenderer.invoke('agents:set-model', { id: modelId }),
    inspectLocal: (nodePath?: string): Promise<LocalAgentEnvironment> => ipcRenderer.invoke('agents:inspect-local', { nodePath }),
    configureLocal: (input: LocalAgentInput): Promise<AgentConfig> => ipcRenderer.invoke('agents:configure-local', input),
    chooseDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('agents:choose-directory'),
    remove: (id: string) => ipcRenderer.invoke('agents:remove', { id }),
    save: (config: AgentConfig) => ipcRenderer.invoke(IPC.agentSave, config), connect: (id: string) => ipcRenderer.invoke(IPC.agentConnect, { id }),
    disconnect: () => ipcRenderer.invoke(IPC.agentDisconnect), attach: () => ipcRenderer.invoke(IPC.agentAttach), detach: () => ipcRenderer.invoke(IPC.agentDetach),
    task: (text: string) => ipcRenderer.invoke(IPC.agentTask, { text }), cancel: () => ipcRenderer.invoke(IPC.agentCancel),
  }),
});
contextBridge.exposeInMainWorld('pilion', api);
