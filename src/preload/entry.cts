import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentConfig,
  AppState,
  BrowserViewport,
  ChromeCookieImportResult,
  ChromeCookieSources,
  PermissionMode,
  PreferencesTarget,
  SkillDetail,
} from '../shared/contracts.js';
import type { LocalAgentEnvironment, LocalAgentInput } from '../shared/local-agents.js';
import type { AppAction } from '../shared/keybindings.js';
import type { AppSettings, AppSettingsPatch } from '../shared/settings.js';

const IPC = {
  getState: 'app:get-state',
  state: 'app:state',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsOpen: 'settings:open',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  tabOpen: 'tabs:open',
  tabActivate: 'tabs:activate',
  tabClose: 'tabs:close',
  tabNavigate: 'tabs:navigate',
  tabBack: 'tabs:back',
  tabForward: 'tabs:forward',
  tabReload: 'tabs:reload',
  tabStop: 'tabs:stop',
  tabDuplicate: 'tabs:duplicate',
  tabReopenClosed: 'tabs:reopen-closed',
  tabFind: 'tabs:find',
  tabStopFind: 'tabs:stop-find',
  tabZoomIn: 'tabs:zoom-in',
  tabZoomOut: 'tabs:zoom-out',
  tabZoomReset: 'tabs:zoom-reset',
  downloadTogglePause: 'downloads:toggle-pause',
  downloadCancel: 'downloads:cancel',
  downloadOpen: 'downloads:open',
  downloadShow: 'downloads:show',
  downloadClear: 'downloads:clear',
  agentSave: 'agents:save',
  agentConnect: 'agents:connect',
  agentDisconnect: 'agents:disconnect',
  agentAttach: 'agents:attach',
  agentDetach: 'agents:detach',
  agentTask: 'agents:task',
  agentCancel: 'agents:cancel',
  agentTakeOver: 'agents:take-over',
  agentResume: 'agents:resume',
  chromeCookieSources: 'cookies:chrome-sources',
  chromeCookieImport: 'cookies:chrome-import',
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingNote: 'recording:note',
  recordingsEvents: 'recordings:events',
  skillsRead: 'skills:read',
  skillsRemove: 'skills:remove',
  skillsRename: 'skills:rename',
  skillsShow: 'skills:show',
  skillsPlay: 'skills:play',
  skillsResume: 'skills:resume',
  skillsStop: 'skills:stop',
  skillsDistill: 'skills:distill',
  skillsKeep: 'skills:keep',
  skillsDiscard: 'skills:discard',
  skillsSave: 'skills:save',
} as const;
// 设置窗口可能在页面挂好监听之前就收到「停在哪」，所以先记下最近一次，订阅时补发。
let preferencesTarget: PreferencesTarget | undefined;
const preferencesListeners = new Set<(target: PreferencesTarget) => void>();
ipcRenderer.on('preferences:open', (_event, target: PreferencesTarget) => {
  preferencesTarget = target;
  for (const listener of preferencesListeners) listener(target);
});
const api = Object.freeze({
  /** 网页里按下、被主进程拦下转过来的快捷键。 */
  onShortcut: (fn: (action: AppAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: AppAction) => fn(action);
    ipcRenderer.on('app:shortcut', listener);
    return () => {
      ipcRenderer.removeListener('app:shortcut', listener);
    };
  },
  /** 原生菜单里点的动作。 */
  onCommand: (fn: (action: AppAction) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: AppAction) => fn(action);
    ipcRenderer.on('app:command', listener);
    return () => {
      ipcRenderer.removeListener('app:command', listener);
    };
  },
  settings: Object.freeze({
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    save: (patch: AppSettingsPatch): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSave, patch),
    /** 从主窗口打开设置窗口，可以指定停在哪一页、预选哪个本地 Agent。 */
    open: (target: PreferencesTarget = {}) => ipcRenderer.invoke(IPC.settingsOpen, target),
    /** 设置窗口接收「停在哪」；订阅之前就到了的那一次会立即补发。 */
    onOpen: (fn: (target: PreferencesTarget) => void) => {
      if (preferencesTarget) fn(preferencesTarget);
      preferencesListeners.add(fn);
      return () => {
        preferencesListeners.delete(fn);
      };
    },
  }),
  updates: Object.freeze({
    /** 立即检查更新，结果随状态广播回来。 */
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    /** 已下载：立即重启安装，有进行中的工作先确认；deb 有新版本：打开 Release 页面。 */
    install: () => ipcRenderer.invoke(IPC.updateInstall),
  }),
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
    return () => {
      ipcRenderer.removeListener(IPC.state, listener);
    };
  },
  tabs: Object.freeze({
    open: (url?: string) => ipcRenderer.invoke(IPC.tabOpen, { url }),
    activate: (id: string) => ipcRenderer.invoke(IPC.tabActivate, { id }),
    close: (id: string) => ipcRenderer.invoke(IPC.tabClose, { id }),
    navigate: (url: string) => ipcRenderer.invoke(IPC.tabNavigate, { url }),
    back: () => ipcRenderer.invoke(IPC.tabBack),
    forward: () => ipcRenderer.invoke(IPC.tabForward),
    reload: () => ipcRenderer.invoke(IPC.tabReload),
    stop: () => ipcRenderer.invoke(IPC.tabStop),
    duplicate: () => ipcRenderer.invoke(IPC.tabDuplicate),
    reopenClosed: () => ipcRenderer.invoke(IPC.tabReopenClosed),
    find: (text: string, forward = true, newSearch = false) =>
      ipcRenderer.invoke(IPC.tabFind, { text, forward, newSearch }),
    stopFind: () => ipcRenderer.invoke(IPC.tabStopFind),
    zoomIn: () => ipcRenderer.invoke(IPC.tabZoomIn),
    zoomOut: () => ipcRenderer.invoke(IPC.tabZoomOut),
    resetZoom: () => ipcRenderer.invoke(IPC.tabZoomReset),
  }),
  downloads: Object.freeze({
    togglePause: (id: string) => ipcRenderer.invoke(IPC.downloadTogglePause, { id }),
    cancel: (id: string) => ipcRenderer.invoke(IPC.downloadCancel, { id }),
    open: (id: string) => ipcRenderer.invoke(IPC.downloadOpen, { id }),
    show: (id: string) => ipcRenderer.invoke(IPC.downloadShow, { id }),
    clear: () => ipcRenderer.invoke(IPC.downloadClear),
  }),
  cookies: Object.freeze({
    chromeSources: (): Promise<ChromeCookieSources> => ipcRenderer.invoke(IPC.chromeCookieSources),
    importChrome: (chromeProfile: string): Promise<ChromeCookieImportResult> =>
      ipcRenderer.invoke(IPC.chromeCookieImport, { chromeProfile }),
  }),
  agents: Object.freeze({
    approve: async (
      approvalId: string,
      nonce: string,
      actionDigest: string,
      decision: 'approve' | 'deny',
    ) => {
      const gestureToken = await ipcRenderer.invoke('approval:gesture', {
        approvalId,
        nonce,
        actionDigest,
      });
      return ipcRenderer.invoke('approval:respond', {
        approvalId,
        nonce,
        actionDigest,
        decision,
        gestureToken,
      });
    },
    setMode: (mode: PermissionMode) => ipcRenderer.invoke('agents:set-mode', { mode }),
    setModel: (modelId: string) => ipcRenderer.invoke('agents:set-model', { id: modelId }),
    inspectLocal: (nodePath?: string): Promise<LocalAgentEnvironment> =>
      ipcRenderer.invoke('agents:inspect-local', { nodePath }),
    configureLocal: (input: LocalAgentInput): Promise<AgentConfig> =>
      ipcRenderer.invoke('agents:configure-local', input),
    chooseDirectory: (): Promise<string | undefined> =>
      ipcRenderer.invoke('agents:choose-directory'),
    remove: (id: string) => ipcRenderer.invoke('agents:remove', { id }),
    save: (config: AgentConfig) => ipcRenderer.invoke(IPC.agentSave, config),
    connect: (id: string) => ipcRenderer.invoke(IPC.agentConnect, { id }),
    disconnect: () => ipcRenderer.invoke(IPC.agentDisconnect),
    attach: () => ipcRenderer.invoke(IPC.agentAttach),
    detach: () => ipcRenderer.invoke(IPC.agentDetach),
    task: (text: string) => ipcRenderer.invoke(IPC.agentTask, { text }),
    cancel: () => ipcRenderer.invoke(IPC.agentCancel),
    takeOver: () => ipcRenderer.invoke(IPC.agentTakeOver),
    resume: (text = '') => ipcRenderer.invoke(IPC.agentResume, { text }),
  }),
  recording: Object.freeze({
    start: () => ipcRenderer.invoke(IPC.recordingStart),
    /** 返回保存后的技能 id；没有录到任何步骤时返回 undefined。 */
    stop: (name: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.recordingStop, { name }),
    note: (text: string) => ipcRenderer.invoke(IPC.recordingNote, { text }),
  }),
  skills: Object.freeze({
    read: (id: string): Promise<SkillDetail> => ipcRenderer.invoke(IPC.skillsRead, { id }),
    /** 主进程已经把过程记录渲染成行了，这里不再传原始事件——录制可能有两万条。 */
    events: (id: string): Promise<{ lines: string[]; capped: boolean; clamped: boolean }> =>
      ipcRenderer.invoke(IPC.recordingsEvents, { id }),
    remove: (id: string) => ipcRenderer.invoke(IPC.skillsRemove, { id }),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC.skillsRename, { id, name }),
    show: (id: string) => ipcRenderer.invoke(IPC.skillsShow, { id }),
    play: (id: string, fromStep?: number) => ipcRenderer.invoke(IPC.skillsPlay, { id, fromStep }),
    resume: () => ipcRenderer.invoke(IPC.skillsResume),
    stop: () => ipcRenderer.invoke(IPC.skillsStop),
    distill: (id: string) => ipcRenderer.invoke(IPC.skillsDistill, { id }),
    keep: () => ipcRenderer.invoke(IPC.skillsKeep),
    discard: () => ipcRenderer.invoke(IPC.skillsDiscard),
    save: (id: string, prose: string, steps: Record<string, unknown>[]) =>
      ipcRenderer.invoke(IPC.skillsSave, { id, prose, steps }),
  }),
});
contextBridge.exposeInMainWorld('pilion', api);
