import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type WebContentsView,
} from 'electron';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceStore } from './workspace.js';
import { AgentShield } from './browser/agent-shield.js';
import { AgentEmptyResponseError, isEmptyAgentReply, runPrompt } from './agents/prompt-runner.js';
import { sshLaunch } from './agents/ssh.js';
import {
  inspectLocalAgents,
  presetConfiguration,
  resolveLocalLaunch,
} from './agents/local-agents.js';
import { LocalAgentInputSchema, LocalInspectSchema } from '../shared/contracts.js';
import {
  AgentProcessManager,
  type AgentGoalSnapshot,
  type AgentTransport,
  BrowserMcpHost,
} from './agents/index.js';
import {
  BrowserError,
  BrowserService,
  ControlledNetworkProxy,
  ElectronPageFactory,
  canonicalizeUrl,
  installNetworkBoundary,
  type BrowserEffect,
  type ElementRef,
  type ExecutionGrantVerifier,
  type GrantContext,
} from './browser/index.js';
import {
  actionDigest,
  canonicalCommandHash,
  canonicalizeCommand,
  classifySemanticRisk,
  DurableHostStore,
  evaluatePolicy,
  ExecutionGrantAuthority,
  sha256,
  type CanonicalCommandV1,
  type ExecutionGrant,
  HostError,
  type PolicyVerdict,
} from './host/index.js';
import {
  AgentConfigInputSchema,
  AgentConfigSchema,
  ApprovalResponseSchema,
  FindInputSchema,
  IdInputSchema,
  IPC,
  NavigateInputSchema,
  TaskInputSchema,
  ResumeTaskInputSchema,
  UrlInputSchema,
  ViewportSchema,
  PermissionInputSchema,
  type AgentConfig,
  type AgentActivityPhase,
  type AgentStatus,
  type AppState,
  type ApprovalResponse,
  type ApprovalViewState,
  type Tab,
  type ToolRequest,
  type BrowserViewport,
  type ConversationMessage,
  type DownloadRecord,
  type FindResult,
} from '../shared/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = 'about:blank';
const PROFILE_ID = 'pilion-default';
const USER_PRINCIPAL = 'local-user';
const POLICY_VERSION = 'pilion-mvp-policy-v1';
const HOST_INSTANCE_ID = randomUUID();

type PageItem = { model: Tab; view: WebContentsView; pendingUrl?: string };
type Connection = {
  config: AgentConfig;
  transport: AgentTransport;
  mcpHost: BrowserMcpHost;
  principal: string;
  sessionId: string;
  capabilitySnapshotHash: string;
  attachmentId?: string;
  connectionEpoch: number;
};
type PendingBrowserApproval = {
  kind: 'browser';
  view: ApprovalViewState;
  nonce: string;
  actionDigest: string;
  tabId: string;
  documentEpoch: number;
  origin: string;
  timer: NodeJS.Timeout;
  resolve: (value: { approvalDigest: string }) => void;
  reject: (error: Error) => void;
};
type PendingAcpApproval = {
  kind: 'acp';
  view: ApprovalViewState;
  nonce: string;
  actionDigest: string;
  sessionId: string;
  timer: NodeJS.Timeout;
  allowOptionId?: string;
  rejectOptionId?: string;
  resolve: (value: RequestPermissionResponse) => void;
};
type PendingApproval = PendingBrowserApproval | PendingAcpApproval;
type GrantBinding = {
  expected: Parameters<ExecutionGrantAuthority['verifyAndConsume']>[1];
  principal: string;
  elementRef?: ElementRef;
  effect?: BrowserEffect;
};

let window: BrowserWindow;
let store: DurableHostStore;
let browser: BrowserService;
let pageFactory: ElectronPageFactory;
let agentShield: AgentShield | undefined;
let connection: Connection | undefined;
let activeTabId: string | undefined;
let agents: AgentConfig[] = [];
let agentStatus: AgentStatus = 'not_configured';
let lastError: string | undefined;
let draining = false;
let attachmentLeaseTimer: NodeJS.Timeout | undefined;
let networkProxy: ControlledNetworkProxy | undefined;
let workspace: WorkspaceStore;
let workspaceTimer: NodeJS.Timeout | undefined;
let viewport: BrowserViewport = { x: 236, y: 88, width: 804, height: 780, visible: true };
let connectionBusy = false;
let promptActive = false;
let toolExecutions = 0;
let restoreReadyAfterTools = false;
let promptCancelled = false;
let activeResponseId: string | undefined;
let taskId: string | undefined;
let findResult: FindResult | undefined;
let activeFind: { tabId: string; text: string } | undefined;
const pages = new Map<string, PageItem>();
const closedTabs: { title: string; url: string }[] = [];
const activeDownloads = new Map<string, DownloadItem>();
const events: string[] = [];
const approvals = new Map<string, PendingApproval>();
const gestureTokens = new Map<
  string,
  { approvalId: string; senderId: number; expiresAt: number }
>();
const grantBindings = new Map<string, GrantBinding>();
const processManager = new AgentProcessManager();
const grants = new ExecutionGrantAuthority(randomBytes(32));

const configPath = () => join(app.getPath('userData'), 'agents.json');
const databasePath = () => join(app.getPath('userData'), 'host.sqlite');
const state = (): AppState => ({
  tabs: [...pages.values()].map((item) => item.model),
  activeTabId,
  agents,
  agentStatus,
  agentActivityPhase: isAgentBrowserActive() ? currentAgentActivityPhase() : undefined,
  attachmentStatus: connection?.attachmentId ? 'attached' : connection ? 'detached' : 'none',
  approvals: [...approvals.values()].map((item) => ({
    ...item.view,
    nonce: item.nonce,
    actionDigest: item.actionDigest,
  })),
  events: events.slice(-100),
  error: lastError,
  connectedAgentId: connection?.config.id,
  conversations: workspace?.data.conversations,
  activeConversationId: workspace?.data.activeConversationId,
  bookmarks: workspace?.data.bookmarks,
  history: workspace?.data.history,
  downloads: workspace?.data.downloads,
  findResult,
  canReopenClosedTab: closedTabs.length > 0,
  agentModels: connection?.transport.models ?? [],
  agentModes:
    connection?.transport.modes.map((mode) => ({ value: mode.id, name: mode.name })) ?? [],
  agentModel: connection?.transport.currentModel,
  agentMode: connection?.transport.currentMode,
  permissionMode: workspace?.data.permissionMode ?? 'full',
});
function emit(): void {
  syncAgentShield();
  if (window && !window.isDestroyed()) window.webContents.send(IPC.state, state());
  if (workspace && !draining) {
    clearTimeout(workspaceTimer);
    workspaceTimer = setTimeout(() => {
      void workspace.save().catch((error) => {
        lastError = `工作区保存失败：${readable(error)}`;
      });
    }, 250);
  }
}
function log(message: string): void {
  events.push(`${new Date().toLocaleTimeString()} ${message}`);
  if (events.length > 100) events.shift();
  emit();
}
function readable(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function taskRunning(): boolean {
  return workspace?.current?.task?.status === 'running';
}
function isAgentBrowserActive(): boolean {
  return (
    (promptActive || taskRunning() || toolExecutions > 0) &&
    !promptCancelled &&
    Boolean(connection?.attachmentId) &&
    agentStatus === 'running'
  );
}
function currentAgentActivityPhase(): AgentActivityPhase {
  if (
    [...approvals.values()].some((item) => item.kind === 'browser' && item.view.state === 'pending')
  )
    return 'confirm';
  return toolExecutions > 0 ? 'act' : 'think';
}

function layout(): void {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  for (const [tabId, item] of pages) {
    item.view.setBounds({
      x: Math.min(width, viewport.x),
      y: Math.min(height, viewport.y),
      width: Math.max(0, Math.min(viewport.width, width - viewport.x)),
      height: Math.max(0, Math.min(viewport.height, height - viewport.y)),
    });
    item.view.setVisible(
      viewport.visible && tabId === activeTabId && item.model.url !== HOME && !item.model.error,
    );
    if (!item.view.getVisible()) pageFactory.pointer.hideFor(item.view);
  }
  syncAgentShield();
}
function syncAgentShield(): void {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const active = isAgentBrowserActive();
  agentShield?.update(
    active,
    {
      x: viewport.x,
      y: viewport.y,
      width: Math.max(0, Math.min(viewport.width, width - viewport.x)),
      height: Math.max(0, Math.min(viewport.height, height - viewport.y)),
    },
    viewport.visible && Boolean(pages.get(activeTabId ?? '')?.view.getVisible()),
    currentAgentActivityPhase(),
  );
}
function sync(tabId: string): void {
  const item = pages.get(tabId);
  if (!item) return;
  const wc = item.view.webContents;
  item.model = {
    ...item.model,
    title: wc.getTitle() || '新标签页',
    url: wc.getURL() || item.model.url,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    zoomPercent: Math.round(wc.getZoomFactor() * 100),
  };
  if (item.model.url !== HOME) item.pendingUrl = undefined;
  if (!item.model.loading)
    workspace.visit({
      url: item.model.url,
      title: item.model.title,
      time: new Date().toISOString(),
    });
  rememberTabs();
  layout();
  emit();
}
function rememberTabs(): void {
  workspace.data.tabs = [...pages.values()].map((item) => item.model.url);
  workspace.data.activeTabIndex = Math.max(0, [...pages.keys()].indexOf(activeTabId ?? ''));
}
function bindPage(tabId: string, view: WebContentsView, url: string): void {
  view.webContents.on('focus', () => {
    if (agentShield?.locked) window.webContents.focus();
  });
  const item: PageItem = {
    model: {
      id: tabId,
      title: '新标签页',
      url,
      loading: true,
      canGoBack: false,
      canGoForward: false,
      zoomPercent: 100,
      crashed: false,
    },
    view,
  };
  pages.set(tabId, item);
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return;
    const key = input.key.toLowerCase();
    const shortcut = input.shift && key === 't' ? 'shift+t' : key;
    if (
      [
        'l',
        'k',
        't',
        'shift+t',
        'w',
        'r',
        'f',
        '=',
        '+',
        '-',
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '[',
        ']',
        ',',
      ].includes(shortcut)
    ) {
      event.preventDefault();
      window.webContents.focus();
      window.webContents.send('app:shortcut', shortcut);
    }
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target))
      void openTab(target).catch((error) => {
        lastError = readable(error);
        emit();
      });
    return { action: 'deny' };
  });
  view.webContents.on('did-start-loading', () => {
    item.model.error = undefined;
    item.model.crashed = false;
    findResult = undefined;
    sync(tabId);
  });
  view.webContents.on('did-stop-loading', () => {
    sync(tabId);
    if (activeFind?.tabId === tabId)
      view.webContents.findInPage(activeFind.text, {
        forward: true,
        findNext: true,
        matchCase: false,
      });
  });
  view.webContents.on('page-title-updated', () => sync(tabId));
  view.webContents.on('did-navigate', () => sync(tabId));
  view.webContents.on('did-navigate-in-page', () => sync(tabId));
  view.webContents.on('found-in-page', (_event, result) => {
    if (tabId !== activeTabId) return;
    findResult = {
      tabId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    };
    emit();
  });
  view.webContents.on('did-frame-navigate', (_event, targetUrl, _code, _status, mainFrame) => {
    if (mainFrame) staleApprovals(tabId, targetUrl);
  });
  view.webContents.on('render-process-gone', () => {
    item.model.crashed = true;
    sync(tabId);
  });
  view.webContents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) {
      item.model.error = description;
      item.model.url = url;
      item.model.loading = false;
      layout();
      emit();
    }
  });
}
async function openTab(url = HOME): Promise<string> {
  const opened = await browser.openTab({ principalId: USER_PRINCIPAL, url: HOME });
  const createdView = pageFactory.pages.find(
    (page) => page === browser.registry.get(opened.tabId).page,
  )?.view;
  if (!createdView) throw new Error('页面适配器未创建');
  bindPage(opened.tabId, createdView, opened.url);
  if (connection?.attachmentId) grantAgentTabAcl(opened.tabId);
  activeTabId = opened.tabId;
  sync(opened.tabId);
  if (url !== HOME) {
    const created = pages.get(opened.tabId);
    if (created) created.pendingUrl = url;
    void browser
      .navigate({ principalId: USER_PRINCIPAL, tabId: opened.tabId, url })
      .catch((error) => {
        const item = pages.get(opened.tabId);
        if (item) {
          item.model.error = readable(error);
          item.model.url = url;
          layout();
          emit();
        }
      });
  }
  layout();
  emit();
  return opened.tabId;
}
async function closeTab(tabId: string, principal = USER_PRINCIPAL): Promise<void> {
  const order = [...pages.keys()];
  const index = order.indexOf(tabId);
  const closing = pages.get(tabId);
  const closed = closing?.model;
  await browser.closeTab(principal, tabId);
  pages.delete(tabId);
  if (closed && !draining) {
    // A tab closed before its first navigation commits still reopens at the page it was opened for.
    const url = closed.url === HOME && closing?.pendingUrl ? closing.pendingUrl : closed.url;
    closedTabs.push({ title: closed.title, url });
    if (closedTabs.length > 20) closedTabs.shift();
  }
  if (activeTabId === tabId) {
    activeTabId = order[index + 1];
    if (!activeTabId || !pages.has(activeTabId)) activeTabId = order[index - 1];
    if (!activeTabId || !pages.has(activeTabId)) activeTabId = pages.keys().next().value;
  }
  if (activeFind?.tabId === tabId) activeFind = undefined;
  findResult = undefined;
  rememberTabs();
  layout();
  emit();
  if (!pages.size && !draining) await openTab();
}
function activateTab(tabId: string, principal = USER_PRINCIPAL): void {
  browser.registry.require(tabId, principal, 'observe');
  if (activeFind) pages.get(activeFind.tabId)?.view.webContents.stopFindInPage('clearSelection');
  activeTabId = tabId;
  activeFind = undefined;
  findResult = undefined;
  rememberTabs();
  layout();
  emit();
}
function requireActiveTab(): string {
  if (!activeTabId || !pages.has(activeTabId)) throw new Error('没有活动标签页');
  return activeTabId;
}
async function duplicateActiveTab(): Promise<string> {
  return openTab(pages.get(requireActiveTab())!.model.url);
}
async function reopenClosedTab(): Promise<string | undefined> {
  const closed = closedTabs.pop();
  if (!closed) return undefined;
  try {
    return await openTab(closed.url);
  } catch (error) {
    closedTabs.push(closed);
    throw error;
  }
}
function stopFind(): void {
  const item = pages.get(activeTabId ?? '');
  item?.view.webContents.stopFindInPage('clearSelection');
  activeFind = undefined;
  findResult = undefined;
  emit();
}
const ZOOM_LEVELS = [50, 67, 80, 90, 100, 110, 125, 150, 175, 200] as const;
function changeZoom(direction: -1 | 0 | 1): void {
  const item = pages.get(requireActiveTab())!;
  const current = Math.round(item.view.webContents.getZoomFactor() * 100);
  const target =
    direction === 0
      ? 100
      : direction > 0
        ? (ZOOM_LEVELS.find((level) => level > current) ?? ZOOM_LEVELS.at(-1)!)
        : ([...ZOOM_LEVELS].reverse().find((level) => level < current) ?? ZOOM_LEVELS[0]);
  item.view.webContents.setZoomFactor(target / 100);
  item.model = { ...item.model, zoomPercent: target };
  emit();
}
function grantAgentTabAcl(tabId: string): void {
  if (!connection) return;
  browser.setTabAcl(USER_PRINCIPAL, tabId, {
    entries: [
      { principalId: USER_PRINCIPAL, role: 'owner' },
      { principalId: connection.principal, role: 'operator' },
    ],
  });
}
function revokeAgentAcls(): void {
  pageFactory.pointer.hide();
  if (connection) browser.invalidatePrincipal(connection.principal);
  for (const tabId of pages.keys())
    browser.setTabAcl(USER_PRINCIPAL, tabId, {
      entries: [{ principalId: USER_PRINCIPAL, role: 'owner' }],
    });
}

function requireAttachment(): Connection & { attachmentId: string } {
  if (!connection?.attachmentId) throw new Error('Agent 尚未附加到浏览器会话');
  return connection as Connection & { attachmentId: string };
}
function attachAgent(): void {
  const current = connection;
  if (!current || current.transport.state !== 'ready') throw new Error('请先连接 Agent');
  if (current.attachmentId) return;
  const attachmentId = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  store.createAttachment({
    attachmentId,
    sessionId: current.sessionId,
    principal: current.principal,
    agentId: current.config.id,
    role: 'owner',
    leaseExpiresAt,
    connectionEpoch: current.connectionEpoch,
    capabilitySnapshotHash: current.capabilitySnapshotHash,
  });
  current.attachmentId = attachmentId;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = setTimeout(
    () => {
      if (connection?.attachmentId !== attachmentId) return;
      try {
        store.transitionAttachment(attachmentId, 'expired');
      } catch {
        /* already terminal */
      }
      expireCurrentAttachment();
    },
    Math.max(0, Date.parse(leaseExpiresAt) - Date.now()),
  );
  attachmentLeaseTimer.unref();
  for (const tabId of pages.keys()) grantAgentTabAcl(tabId);
  log('Agent 已附加；Session / Attachment / Tab ACL 生效');
}
function detachAgent(): void {
  if (!connection?.attachmentId) return;
  store.transitionAttachment(connection.attachmentId, 'detached');
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  cancelBrowserApprovals();
  cancelAcpApprovals(connection.transport.sessionId);
  log('Agent 已分离，Tab effect 权限已撤销');
}

async function connectAgent(id: string): Promise<void> {
  await disconnectAgent();
  const config = agents.find((item) => item.id === id && item.enabled);
  if (!config) throw new Error('Agent 配置不存在或已禁用');
  const resumableConversation =
    workspace.current?.agentId === config.id ? workspace.current : undefined;
  agentStatus = 'starting';
  lastError = undefined;
  emit();
  const mcpHost = new BrowserMcpHost({
    directory: join(app.getPath('userData'), 'mcp'),
    bridgePath: join(__dirname, 'agents/browser-mcp-bridge.js'),
    execute: executeTool,
  });
  try {
    const remoteSocket =
      config.transport === 'ssh' ? `/tmp/pilion-${randomUUID()}.sock` : undefined;
    const mcpServer = await mcpHost.start(remoteSocket);
    const launch = remoteSocket
      ? sshLaunch(config, mcpHost.socketPath, remoteSocket)
      : await resolveLocalLaunch(config);
    const trusted = processManager.approve(launch);
    const transport = await processManager.connect(trusted, {
      limits: { handshakeTimeoutMs: config.preset ? 180_000 : 30_000 },
      session: {
        cwd: config.cwd ?? process.cwd(),
        mcpServers: [mcpServer],
        authMethodId: config.authMethodId,
        resumeSessionId: resumableConversation?.acpSessionId,
        requestPermission: requestAgentPermission,
      },
    });
    try {
      await transport.setPermissionMode(workspace.data.permissionMode);
    } catch (error) {
      await transport.stop();
      throw error;
    }
    const sessionId = randomUUID();
    const principal = `agent:${config.id}`;
    const capabilitySnapshotHash = sha256(transport.capabilities);
    store.createSession({
      sessionId,
      profileId: PROFILE_ID,
      principal,
      agentId: config.id,
      connectionEpoch: 1,
      capabilitySnapshotHash,
    });
    connection = {
      config,
      transport,
      mcpHost,
      principal,
      sessionId,
      capabilitySnapshotHash,
      connectionEpoch: 1,
    };
    transport.on('sessionUpdate', (update) => {
      if (connection?.transport === transport) handleSessionUpdate(update);
    });
    transport.on('goal', (goal) => {
      if (connection?.transport === transport) handleGoalUpdate(goal);
    });
    transport.on('trace', (trace) => {
      if (
        connection?.transport === transport &&
        (trace.method === 'session/prompt' ||
          trace.method === transport.capabilities.goal?.controlMethod)
      )
        log(
          `ACP ${trace.direction === 'client_to_agent' ? '→' : '←'} ${trace.method} ${trace.outcome ?? trace.kind}`,
        );
    });
    transport.on('stderr', (value) => {
      if (value.chunk) log(`Agent stderr: ${value.chunk.slice(0, 500)}`);
    });
    transport.on('protocolError', (transportError) => {
      void failConnection(transport, transportError);
    });
    transport.on('state', (value) => {
      if (value.current === 'closed' && connection?.transport === transport) {
        agentStatus = 'disconnected';
        emit();
      }
    });
    agentStatus = 'ready';
    if (
      !workspace.current ||
      (workspace.current.agentId && workspace.current.agentId !== config.id)
    )
      workspace.create(randomUUID(), config.id);
    else workspace.current.agentId = config.id;
    workspace.current!.acpSessionId = transport.sessionId;
    if (workspace.current!.task?.status !== 'running' && transport.goal?.status === 'active')
      await transport.clearGoal();
    attachAgent();
    const agentName =
      transport.capabilities.agentInfo?.title ??
      transport.capabilities.agentInfo?.name ??
      config.name;
    log(`${agentName} 已通过 ACP v${transport.capabilities.protocol} 连接`);
  } catch (error) {
    await mcpHost.stop();
    agentStatus = 'error';
    lastError = `Agent 连接失败：${readable(error)}`;
    emit();
    throw error;
  }
}
async function failConnection(transport: AgentTransport, failure: unknown): Promise<void> {
  if (connection?.transport !== transport) return;
  const failed = connection;
  lastError = `Agent 协议失败：${readable(failure)}`;
  agentStatus = 'error';
  const attachmentId = connection.attachmentId;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  if (attachmentId) {
    try {
      store.transitionAttachment(attachmentId, 'failed');
    } catch {
      /* already terminal */
    }
  }
  try {
    store.transitionSession(connection.sessionId, 'failed');
  } catch {
    /* already terminal */
  }
  cancelBrowserApprovals();
  cancelAcpApprovals(transport.sessionId);
  connection = undefined;
  emit();
  await transport.stop();
  await failed.mcpHost.stop();
}
function expireCurrentAttachment(): void {
  if (!connection?.attachmentId) return;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  lastError = 'Attachment lease 已过期，Agent Tab ACL 已撤销';
  cancelBrowserApprovals();
  cancelAcpApprovals(connection.transport.sessionId);
  emit();
}
async function disconnectAgent(): Promise<void> {
  const current = connection;
  if (!current) return;
  agentStatus = 'stopping';
  emit();
  if (current.attachmentId) detachAgent();
  try {
    store.transitionSession(current.sessionId, 'draining');
  } catch {
    /* already terminal */
  }
  cancelAcpApprovals(current.transport.sessionId);
  if (current.transport.goal?.status === 'active')
    await current.transport.clearGoal().catch(() => undefined);
  await current.transport.stop();
  await current.mcpHost.stop();
  try {
    store.transitionSession(current.sessionId, 'closed');
  } catch {
    /* already terminal */
  }
  connection = undefined;
  agentStatus = 'disconnected';
  emit();
}

function handleSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate === 'config_option_update' ||
    update.sessionUpdate === 'current_mode_update'
  ) {
    emit();
    return;
  }
  if (promptCancelled || !workspace.current) return;
  const updateRunning = promptActive || workspace.current.task?.status === 'running';
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk') &&
    update.content.type === 'text'
  ) {
    const role = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought';
    let message = workspace.current.messages.find((item) => item.id === activeResponseId);
    if (!message || message.role !== role) {
      message = {
        id: randomUUID(),
        role,
        text: '',
        time: new Date().toISOString(),
        status: updateRunning ? 'running' : 'completed',
      };
      workspace.append(message);
      activeResponseId = message.id;
    }
    message.text += update.content.text;
    emit();
    return;
  }
  if (update.sessionUpdate === 'tool_call') {
    activeResponseId = undefined;
    const id = `${taskId ?? 'session'}:${update.toolCallId}`;
    const existing = workspace.current.messages.find((item) => item.id === id);
    const status =
      update.status === 'completed' || update.status === 'failed' ? update.status : 'running';
    if (existing) {
      existing.text = update.title;
      if (status !== 'running' || existing.status === 'running') existing.status = status;
    } else
      workspace.append({
        id,
        role: 'tool',
        text: update.title,
        time: new Date().toISOString(),
        status,
      });
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const tool = workspace.current.messages.find(
      (item) => item.id === `${taskId ?? 'session'}:${update.toolCallId}`,
    );
    if (tool) {
      if (update.title) tool.text = update.title;
      if (update.status === 'completed' || update.status === 'failed') tool.status = update.status;
    }
  }
  if (update.sessionUpdate === 'plan') {
    const planId = `${taskId ?? 'session'}:plan`;
    let plan = workspace.current.messages.find((item) => item.id === planId);
    if (!plan) {
      plan = { id: planId, role: 'tool', text: '', time: new Date().toISOString() };
      workspace.append(plan);
    }
    plan.text = update.entries
      .map((entry) => `${entry.status === 'completed' ? '[x]' : '[ ]'} ${entry.content}`)
      .join('\n');
  }
  emit();
}

function handleGoalUpdate(goal: AgentGoalSnapshot | null): void {
  const conversation = workspace.current;
  const task = conversation?.task;
  if (!conversation || !task || task.executionMode !== 'goal') return;
  task.agentGoalStatus = goal?.status;
  task.lastReason = goal?.lastReason;
  task.updatedAt = new Date().toISOString();
  if (task.status !== 'running') {
    emit();
    return;
  }
  if (goal?.status === 'active') {
    agentStatus = 'running';
    emit();
    return;
  }
  if (goal && ['paused', 'blocked', 'limited'].includes(goal.status)) {
    task.status = 'manual';
    for (const message of conversation.messages)
      if (message.status === 'running') message.status = 'cancelled';
    agentStatus = 'ready';
    activeResponseId = undefined;
    const reason = goal.lastReason?.trim();
    if (reason)
      conversation.messages.push({
        id: randomUUID(),
        role: 'system',
        text: reason,
        time: new Date().toISOString(),
        status: 'failed',
      });
    emit();
    return;
  }
  task.status = 'completed';
  for (const message of conversation.messages)
    if (message.status === 'running') message.status = 'completed';
  activeResponseId = undefined;
  if (!promptActive) agentStatus = 'ready';
  emit();
}

async function executeTool(request: ToolRequest): Promise<unknown> {
  if (promptCancelled) throw new Error('任务已停止，浏览器操作已取消');
  if (toolExecutions === 0 && agentStatus === 'ready') {
    restoreReadyAfterTools = true;
    agentStatus = 'running';
  }
  toolExecutions += 1;
  emit();
  try {
    return await runTool(request);
  } finally {
    toolExecutions = Math.max(0, toolExecutions - 1);
    if (toolExecutions === 0 && restoreReadyAfterTools) {
      restoreReadyAfterTools = false;
      if (agentStatus === 'running' && !taskRunning()) agentStatus = 'ready';
    }
    emit();
  }
}
async function runTool(request: ToolRequest): Promise<unknown> {
  log(`Agent 正在执行：${request.name}`);
  const current = requireAttachment();
  const tabId = targetTab(request);
  const snapshot =
    tabId && browser.registry.has(tabId)
      ? await browser.registry.get(tabId).page.snapshot()
      : { url: HOME, title: '', loading: false };
  const elementRef = effectRef(request);
  const effect = effectFor(request);
  const trustedElement =
    effect && elementRef && tabId
      ? await browser.describeElement(current.principal, tabId, elementRef)
      : undefined;
  if (effect && trustedElement) validateTrustedEffectTarget(trustedElement, effect);
  const dataFlowClassifications =
    effect?.kind === 'type'
      ? [`text-sha256:${sha256(effect.text)}`, `text-length:${effect.text.length}`]
      : [];
  const pageUrl = snapshot.url || HOME;
  const pageOrigin = pageUrl === HOME ? HOME : new URL(pageUrl).origin;
  const effectDestination = trustedElement?.formAction
    ? safeOrigin(trustedElement.formAction) || pageOrigin
    : pageOrigin;
  const semanticComplete =
    !effect ||
    Boolean(
      trustedElement?.role?.trim() &&
      trustedElement.name?.trim() &&
      (effect.kind !== 'type' || trustedElement.inputType?.trim()),
    );
  const classification = classifySemanticRisk({
    operation: request.name,
    elementRole: trustedElement?.role,
    accessibleName: trustedElement?.name,
    inputType: trustedElement?.inputType,
    targetOrigin: effectDestination,
    changesExternalState: Boolean(effect),
    classifierConfident: semanticComplete,
  });
  const verdict: PolicyVerdict =
    workspace.data.permissionMode === 'full'
      ? {
          verdict: 'allow',
          policySetVersion: POLICY_VERSION,
          reasonCodes: classification.reasons,
          obligations: effect ? [{ type: 'revalidate_target', parameters: {} }] : [],
        }
      : evaluatePolicy({
          classification,
          policySetVersion: POLICY_VERSION,
          policyLoaded: true,
          trustedApprovalAvailable: true,
          contextComplete:
            Boolean(snapshot.url) && (!effect || Boolean(elementRef)) && semanticComplete,
        });
  if (verdict.verdict === 'deny') throw new Error(`策略拒绝：${verdict.reasonCodes.join(', ')}`);
  const actionId = randomUUID();
  const targetEpoch =
    tabId && browser.registry.has(tabId) ? browser.registry.get(tabId).documentEpoch : 0;
  const command = canonicalizeCommand({
    schemaVersion: '1',
    tool: { name: request.name, version: '1' },
    arguments: trustedCommandArguments(request, tabId, trustedElement, effect),
    profileId: PROFILE_ID,
    sessionId: current.sessionId,
    tabId: tabId ?? 'workspace',
    target: {
      origin: pageOrigin,
      documentEpoch: String(targetEpoch),
      frameId: elementRef?.frameId,
      frameEpoch: elementRef?.frameEpoch,
      elementRef: elementRef?.id,
      localFingerprint: elementRef?.localFingerprint,
    },
    effect: classification.effect,
    dataFlow: {
      source: 'agent',
      destination: effectDestination,
      classifications: dataFlowClassifications,
    },
    obligations: verdict.obligations,
  });
  const commandHash = canonicalCommandHash(command);
  const digest = actionDigest({ command, policySetVersion: POLICY_VERSION });
  const approvalId = verdict.verdict === 'require_approval' ? randomUUID() : undefined;
  const nonce = approvalId ? randomBytes(24).toString('base64url') : undefined;
  store.createIntent({
    actionId,
    sessionId: current.sessionId,
    attachmentId: current.attachmentId,
    connectionEpoch: current.connectionEpoch,
    tabId: tabId ?? 'workspace',
    canonicalCommandHash: commandHash,
    actionDigest: digest,
    canonicalCommand: command,
    idempotencyKey: request.requestId,
    revisionPreconditions: command.target,
    policySetVersion: POLICY_VERSION,
    policyVerdict: verdict.verdict,
    policyReasons: verdict.reasonCodes,
    obligations: verdict.obligations,
    approval:
      approvalId && nonce
        ? { approvalId, nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : undefined,
  });
  let approvalDigest: string | undefined;
  if (approvalId && nonce)
    approvalDigest = (
      await requestApproval({
        approvalId,
        nonce,
        digest,
        tool: request.name,
        tabId: tabId!,
        documentEpoch: targetEpoch,
        origin: command.target.origin,
        summary: trustedApprovalSummary(command, trustedElement, effect),
      })
    ).approvalDigest;
  return executePreparedAction({
    request,
    current,
    command,
    commandHash,
    digest,
    verdict,
    actionId,
    tabId,
    elementRef,
    effect,
    approvalId,
    approvalDigest,
  });
}

async function executePreparedAction(input: {
  request: ToolRequest;
  current: Connection & { attachmentId: string };
  command: CanonicalCommandV1;
  commandHash: string;
  digest: string;
  verdict: PolicyVerdict;
  actionId: string;
  tabId?: string;
  elementRef?: ElementRef;
  effect?: BrowserEffect;
  approvalId?: string;
  approvalDigest?: string;
}): Promise<unknown> {
  const attemptId = randomUUID();
  const tabId = input.tabId ?? 'workspace';
  const prepared = store.prepareExecution({
    actionId: input.actionId,
    attemptId,
    sessionId: input.current.sessionId,
    attachmentId: input.current.attachmentId,
    connectionEpoch: input.current.connectionEpoch,
    tabId,
    policySetVersion: POLICY_VERSION,
    capabilitySnapshotHash: input.current.capabilitySnapshotHash,
    expectedApprovalDigest: input.approvalDigest,
  });
  const deadline = new Date(Date.now() + (input.request.timeoutMs ?? 15_000)).toISOString();
  const grant = grants.issue({
    hostInstanceId: HOST_INSTANCE_ID,
    profileId: PROFILE_ID,
    sessionId: input.current.sessionId,
    attachmentId: input.current.attachmentId,
    connectionEpoch: input.current.connectionEpoch,
    tabId,
    actionId: input.actionId,
    attemptId,
    canonicalCommandHash: input.commandHash,
    actionDigest: input.digest,
    capabilitySnapshotHash: input.current.capabilitySnapshotHash,
    policySetVersion: POLICY_VERSION,
    policyVerdict: input.verdict.verdict as 'allow' | 'require_approval',
    approvalId: input.approvalId,
    approvalDigest: input.approvalDigest,
    fencingToken: prepared.fencingToken,
    deadline,
    obligations: input.verdict.obligations.map((obligation) =>
      obligation.type === 'revalidate_target'
        ? {
            type: obligation.type,
            parameters: {
              documentEpoch: input.command.target.documentEpoch,
              frameEpoch: input.command.target.frameEpoch,
              localFingerprint: input.command.target.localFingerprint,
            },
          }
        : obligation.type === 'trusted_approval'
          ? { type: obligation.type, parameters: { approvalDigest: input.approvalDigest } }
          : obligation,
    ),
  });
  const expected = {
    hostInstanceId: HOST_INSTANCE_ID,
    profileId: PROFILE_ID,
    sessionId: input.current.sessionId,
    attachmentId: input.current.attachmentId,
    connectionEpoch: input.current.connectionEpoch,
    tabId,
    actionId: input.actionId,
    attemptId,
    canonicalCommandHash: input.commandHash,
    actionDigest: input.digest,
    capabilitySnapshotHash: input.current.capabilitySnapshotHash,
    policySetVersion: POLICY_VERSION,
  };
  try {
    let result: unknown;
    if (input.effect && input.elementRef && input.tabId) {
      grantBindings.set(grant.grantId, {
        expected,
        principal: input.current.principal,
        elementRef: input.elementRef,
        effect: input.effect,
      });
      const browserPrepared = await browser.prepareEffect({
        principalId: input.current.principal,
        tabId: input.tabId,
        elementRef: input.elementRef,
        effect: input.effect,
        grant,
      });
      store.markDispatched(attemptId, grant.grantId);
      store.markEffectStarted(attemptId);
      result = await browser.executePrepared({
        principalId: input.current.principal,
        executionToken: browserPrepared.executionToken,
      });
    } else {
      grants.verifyAndConsume(grant, expected, store);
      store.markDispatched(attemptId, grant.grantId);
      store.markEffectStarted(attemptId);
      result = await performTool(input.request, input.current.principal, input.tabId);
    }
    store.recordResult({ attemptId, outcome: 'succeeded', result });
    log(`Action ${input.request.name} 已完成并写入 result/outbox`);
    return result;
  } catch (error) {
    const attempt = store.getAttempt(attemptId);
    if (attempt && ['dispatched', 'effect_started'].includes(String(attempt.state))) {
      store.recordResult({
        attemptId,
        outcome: String(attempt.state) === 'effect_started' ? 'outcome_unknown' : 'failed',
        errorCode: 'EXECUTION_FAILED',
      });
    } else store.reconcileExecuting({ [attemptId]: 'not_consumed' });
    throw error;
  } finally {
    grantBindings.delete(grant.grantId);
  }
}

async function performTool(
  request: ToolRequest,
  principal: string,
  boundTabId: string | undefined,
): Promise<unknown> {
  const suppliedTabId = typeof request.args.tabId === 'string' ? request.args.tabId : undefined;
  if (suppliedTabId && suppliedTabId !== boundTabId)
    throw new Error('执行阶段 tabId 与 Intent 绑定不一致');
  const tabId = boundTabId;
  switch (request.name) {
    case 'browser.tabs.list':
      return browser.registry
        .listFor(principal)
        .map((tab) => pages.get(tab.id)?.model)
        .filter(Boolean);
    case 'browser.tabs.open':
      return { tabId: await openAgentTab(principal, String(request.args.url ?? HOME)) };
    case 'browser.tabs.activate':
      activateTab(requireString(request.args.tabId, 'tabId'), principal);
      return { ok: true };
    case 'browser.tabs.close':
      await closeTab(requireString(request.args.tabId, 'tabId'), principal);
      return { ok: true };
    case 'browser.navigate':
      return browser.navigate({
        principalId: principal,
        tabId: tabId!,
        url: requireString(request.args.url, 'url'),
      });
    case 'browser.snapshot':
    case 'browser.page_info': {
      const page = browser.registry.require(tabId!, principal, 'observe').page;
      const text = await page.readText?.();
      browser.registry.require(tabId!, principal, 'observe');
      authorizeBrowserPrincipal(principal);
      return { ...(await page.snapshot()), text };
    }
    case 'browser.screenshot': {
      const page = browser.registry.require(tabId!, principal, 'observe').page;
      return page.screenshot();
    }
    case 'browser.observe':
      return browser.observe({ principalId: principal, tabId: tabId! });
    default:
      throw new Error('Effect tool 未进入受控 prepareEffect 路径');
  }
}
async function openAgentTab(principal: string, url: string): Promise<string> {
  const before = pageFactory.pages.length;
  const opened = await browser.openTab({ principalId: principal, url });
  const view = pageFactory.pages[before]?.view;
  if (!view) throw new Error('页面适配器未创建');
  browser.setTabAcl(principal, opened.tabId, {
    entries: [
      { principalId: principal, role: 'owner' },
      { principalId: USER_PRINCIPAL, role: 'owner' },
    ],
  });
  bindPage(opened.tabId, view, opened.url);
  activeTabId = opened.tabId;
  layout();
  emit();
  return opened.tabId;
}

function targetTab(request: ToolRequest): string | undefined {
  if (request.name === 'browser.tabs.open' || request.name === 'browser.tabs.list')
    return undefined;
  return typeof request.args.tabId === 'string' ? request.args.tabId : activeTabId;
}
function trustedCommandArguments(
  request: ToolRequest,
  tabId: string | undefined,
  element:
    | {
        role: string;
        name: string;
        disabled: boolean;
        tagName: string;
        inputType?: string;
        formAction?: string;
        optionValues?: ReadonlyArray<string>;
        checked?: boolean;
      }
    | undefined,
  effect: BrowserEffect | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(tabId ? { tabId } : {}) };
  if (request.name === 'browser.navigate' || request.name === 'browser.tabs.open')
    base.url = requireString(request.args.url ?? HOME, 'url');
  if (element)
    base.target = {
      role: element.role,
      name: element.name,
      disabled: element.disabled,
      tagName: element.tagName,
      ...(element.inputType ? { inputType: element.inputType } : {}),
      ...(element.formAction ? { formAction: element.formAction } : {}),
      ...(element.checked === undefined ? {} : { checked: element.checked }),
    };
  if (effect?.kind === 'type')
    base.input = {
      sha256: sha256(effect.text),
      length: effect.text.length,
      replace: effect.replace !== false,
    };
  if (effect?.kind === 'click') base.effect = 'click';
  if (effect?.kind === 'select') base.selection = { value: effect.value };
  if (effect?.kind === 'check') base.check = { checked: effect.checked };
  if (effect?.kind === 'press') base.key = { key: effect.key, modifiers: [...effect.modifiers] };
  return base;
}
function trustedApprovalSummary(
  command: CanonicalCommandV1,
  element:
    | {
        role: string;
        name: string;
        tagName: string;
        inputType?: string;
        formAction?: string;
        optionValues?: ReadonlyArray<string>;
        checked?: boolean;
      }
    | undefined,
  effect: BrowserEffect | undefined,
): string {
  const operation =
    effect?.kind === 'type'
      ? '输入文本'
      : effect?.kind === 'click'
        ? '点击'
        : effect?.kind === 'select'
          ? `选择选项“${effect.value}”`
          : effect?.kind === 'check'
            ? effect.checked
              ? '选中'
              : '取消选中'
            : effect?.kind === 'press'
              ? `按键 ${[...effect.modifiers, effect.key].join('+')}`
              : command.tool.name;
  const target = element ? `${element.role}“${element.name || '未命名元素'}”` : '页面';
  const data =
    effect?.kind === 'type'
      ? `文本 ${effect.text.length} 个字符（内容不显示，SHA-256 ${sha256(effect.text).slice(0, 12)}…）`
      : '无文本数据';
  const semantic = element
    ? `\n输入类型：${element.inputType ?? '不适用'}\n表单目标：${element.formAction ?? '当前站点'}`
    : '';
  return `来源：可信页面快照\n站点：${command.target.origin}\n操作：${operation}\n目标：${target}${semantic}\n数据流：Agent → ${command.dataFlow.destination}\n数据摘要：${data}`;
}
function validateTrustedEffectTarget(
  element: {
    disabled: boolean;
    tagName: string;
    inputType?: string;
    optionValues?: ReadonlyArray<string>;
  },
  effect: BrowserEffect,
): void {
  if (element.disabled) throw new BrowserError('UNSUPPORTED_ELEMENT', '目标元素已禁用');
  if (effect.kind === 'select') {
    if (element.tagName !== 'select')
      throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.select 仅允许 <select>');
    if (!element.optionValues?.includes(effect.value))
      throw new BrowserError('OPTION_NOT_FOUND', '目标 <select> 中不存在指定 option');
  }
  if (
    effect.kind === 'check' &&
    (element.tagName !== 'input' || !['checkbox', 'radio'].includes(element.inputType ?? ''))
  ) {
    throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.check 仅允许 checkbox/radio');
  }
  if (effect.kind === 'check' && element.inputType === 'radio' && !effect.checked) {
    throw new BrowserError('UNSUPPORTED_ELEMENT', 'radio 不支持直接取消选中');
  }
}

function effectFor(request: ToolRequest): BrowserEffect | undefined {
  if (request.name === 'browser.click') return { kind: 'click' };
  if (request.name === 'browser.type')
    return {
      kind: 'type',
      text: requireString(request.args.text, 'text'),
      replace: request.args.replace !== false,
    };
  if (request.name === 'browser.select')
    return { kind: 'select', value: requireString(request.args.value, 'value') };
  if (request.name === 'browser.check')
    return { kind: 'check', checked: request.args.checked as boolean };
  if (request.name === 'browser.press')
    return {
      kind: 'press',
      key: request.args.key as Extract<BrowserEffect, { kind: 'press' }>['key'],
      modifiers: (request.args.modifiers ?? []) as Extract<
        BrowserEffect,
        { kind: 'press' }
      >['modifiers'],
    };
  return undefined;
}
function effectRef(request: ToolRequest): ElementRef | undefined {
  if (!effectFor(request)) return undefined;
  const ref = request.args.elementRef;
  if (!ref || typeof ref !== 'object')
    throw new Error(`${request.name} 必须携带 observe 返回的 elementRef`);
  return ref as ElementRef;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function requestApproval(input: {
  approvalId: string;
  nonce: string;
  digest: string;
  tool: ToolRequest['name'];
  summary: string;
  tabId: string;
  documentEpoch: number;
  origin: string;
}): Promise<{ approvalDigest: string }> {
  return new Promise((resolve, reject) => {
    const view: ApprovalViewState = {
      approvalId: input.approvalId,
      tool: input.tool,
      summary: input.summary,
      state: 'pending',
      statusText: '请确认页面和操作内容。页面变化后该审批将自动失效。',
    };
    const timer = setTimeout(() => {
      const active = approvals.get(input.approvalId);
      if (!active || active.kind !== 'browser') return;
      try {
        store.resolveApproval({
          approvalId: input.approvalId,
          nonce: input.nonce,
          actionDigest: input.digest,
          decision: 'deny',
          bindingValid: true,
        });
      } catch {
        /* already resolved */
      }
      active.view.state = 'expired';
      approvals.delete(input.approvalId);
      active.reject(new Error('审批已过期'));
      emit();
    }, 60_005);
    const pending: PendingBrowserApproval = {
      kind: 'browser',
      view,
      nonce: input.nonce,
      actionDigest: input.digest,
      tabId: input.tabId,
      documentEpoch: input.documentEpoch,
      origin: input.origin,
      timer,
      resolve,
      reject,
    };
    approvals.set(input.approvalId, pending);
    emit();
  });
}
function staleApprovals(tabId: string, targetUrl?: string): void {
  for (const pending of [...approvals.values()]) {
    if (pending.kind !== 'browser' || pending.tabId !== tabId) continue;
    const tab = browser.registry.has(tabId) ? browser.registry.get(tabId) : undefined;
    const changed =
      !tab ||
      tab.documentEpoch !== pending.documentEpoch ||
      (targetUrl && safeOrigin(targetUrl) !== pending.origin);
    if (!changed) continue;
    try {
      store.resolveApproval({
        approvalId: pending.view.approvalId,
        nonce: pending.nonce,
        actionDigest: pending.actionDigest,
        decision: 'deny',
        bindingValid: false,
      });
    } catch {
      /* already resolved */
    }
    clearTimeout(pending.timer);
    pending.view.state = 'stale';
    approvals.delete(pending.view.approvalId);
    pending.reject(new Error('页面已变化，审批已失效'));
    emit();
  }
}
function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}
function cancelBrowserApprovals(): void {
  for (const pending of [...approvals.values()]) {
    if (pending.kind !== 'browser') continue;
    try {
      store.resolveApproval({
        approvalId: pending.view.approvalId,
        nonce: pending.nonce,
        actionDigest: pending.actionDigest,
        decision: 'deny',
        bindingValid: true,
      });
    } catch {
      /* already terminal */
    }
    approvals.delete(pending.view.approvalId);
    clearTimeout(pending.timer);
    pending.reject(new Error('用户已取消操作'));
  }
}
function approvalSender(event: IpcMainInvokeEvent, approvalId: string): PendingApproval {
  trustedRenderer(event);
  const pending = approvals.get(approvalId);
  if (!pending) throw new Error('审批已结束或不存在');
  return pending;
}
function respondApproval(event: IpcMainInvokeEvent, response: ApprovalResponse): void {
  const pending = approvalSender(event, response.approvalId);
  if (
    pending.view.approvalId !== response.approvalId ||
    pending.nonce !== response.nonce ||
    pending.actionDigest !== response.actionDigest
  )
    throw new Error('审批 nonce/actionDigest 绑定失败');
  const gesture = gestureTokens.get(response.gestureToken);
  gestureTokens.delete(response.gestureToken);
  if (
    !gesture ||
    gesture.senderId !== event.sender.id ||
    gesture.approvalId !== response.approvalId ||
    gesture.expiresAt < Date.now()
  )
    throw new Error('审批缺少有效用户手势');
  if (pending.kind === 'acp') {
    const optionId =
      response.decision === 'approve' ? pending.allowOptionId : pending.rejectOptionId;
    pending.view.state = response.decision === 'approve' && optionId ? 'approved' : 'denied';
    clearTimeout(pending.timer);
    approvals.delete(response.approvalId);
    emit();
    pending.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
    return;
  }
  const tab = browser.registry.has(pending.tabId) ? browser.registry.get(pending.tabId) : undefined;
  const currentOrigin = safeOrigin(pages.get(pending.tabId)?.view.webContents.getURL() ?? '');
  const bindingValid = Boolean(
    tab && tab.documentEpoch === pending.documentEpoch && currentOrigin === pending.origin,
  );
  const resolved = store.resolveApproval({
    approvalId: response.approvalId,
    nonce: response.nonce,
    actionDigest: response.actionDigest,
    decision: response.decision,
    bindingValid,
  });
  pending.view.state = resolved.approvalState;
  clearTimeout(pending.timer);
  approvals.delete(response.approvalId);
  emit();
  if (resolved.approvalState === 'approved' && resolved.approvalDigest)
    pending.resolve({ approvalDigest: resolved.approvalDigest });
  else
    pending.reject(
      new Error(resolved.approvalState === 'stale' ? '页面已变化，审批失效' : '用户拒绝了操作'),
    );
}

function requestAgentPermission(
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  if (promptCancelled) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  const approvalId = randomUUID();
  const nonce = randomBytes(24).toString('base64url');
  const actionDigest = sha256(request);
  const allowOptionId =
    request.options.find((option) => option.kind === 'allow_once')?.optionId ??
    request.options.find((option) => option.kind === 'allow_always')?.optionId;
  const rejectOptionId =
    request.options.find((option) => option.kind === 'reject_once')?.optionId ??
    request.options.find((option) => option.kind === 'reject_always')?.optionId;
  const allowByDefault = workspace.data.permissionMode === 'full';
  if (allowByDefault && allowOptionId)
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOptionId } });
  const toolTitle = (request.toolCall.title ?? '未命名工具').slice(0, 256);
  const rawInput =
    request.toolCall.rawInput === undefined
      ? '未提供'
      : JSON.stringify(request.toolCall.rawInput, null, 2).slice(0, 4_000);
  const summary = [
    '来源：Agent 提供的工具描述（未经 Pilion 验证）',
    `操作：${toolTitle}`,
    `类型：${request.toolCall.kind ?? 'other'}`,
    `输入：${rawInput}`,
  ].join('\n');
  return new Promise((resolvePermission) => {
    const view: ApprovalViewState = {
      approvalId,
      tool: toolTitle,
      summary,
      state: 'pending',
      statusText: '该请求来自 Agent。请根据工具名称和输入内容决定是否授权一次。',
    };
    const finishCancelled = (): void => {
      if (!approvals.delete(approvalId)) return;
      clearTimeout(timer);
      view.state = 'expired';
      emit();
      resolvePermission({ outcome: { outcome: 'cancelled' } });
    };
    const timer = setTimeout(finishCancelled, 60_005);
    const pending: PendingAcpApproval = {
      kind: 'acp',
      view,
      nonce,
      actionDigest,
      sessionId: request.sessionId,
      timer,
      allowOptionId,
      rejectOptionId,
      resolve: resolvePermission,
    };
    approvals.set(approvalId, pending);
    emit();
  });
}

function cancelAcpApprovals(sessionId?: string): void {
  if (!sessionId) return;
  for (const pending of [...approvals.values()]) {
    if (pending.kind !== 'acp' || pending.sessionId !== sessionId) continue;
    clearTimeout(pending.timer);
    approvals.delete(pending.view.approvalId);
    pending.resolve({ outcome: { outcome: 'cancelled' } });
  }
  emit();
}

function trustedRenderer(event: IpcMainInvokeEvent): void {
  const senderFrame = event.senderFrame;
  if (
    !window ||
    !senderFrame ||
    event.sender !== window.webContents ||
    senderFrame !== window.webContents.mainFrame
  )
    throw new Error('拒绝非可信 Renderer IPC sender/frame');
  const expected = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : pathToFileURL(join(app.getAppPath(), 'dist-renderer/index.html')).href;
  if (
    process.env.VITE_DEV_SERVER_URL
      ? new URL(senderFrame.url).origin !== expected
      : senderFrame.url !== expected
  )
    throw new Error('拒绝非可信 Renderer origin');
}
function handle<T>(
  channel: string,
  schema: { parse(value: unknown): T } | undefined,
  fn: (value: T) => unknown,
): void {
  ipcMain.handle(channel, (event, value) => {
    trustedRenderer(event);
    return fn(schema ? schema.parse(value) : (value as T));
  });
}
function authorizeBrowserPrincipal(principalId: string): void {
  if (principalId === USER_PRINCIPAL) return;
  const current = connection;
  if (
    !current?.attachmentId ||
    current.principal !== principalId ||
    current.transport.state !== 'ready'
  ) {
    throw new HostError('INVALID_STATE_TRANSITION', 'Agent attachment is no longer active');
  }
  try {
    store.assertAttachmentAccess({
      sessionId: current.sessionId,
      attachmentId: current.attachmentId,
      principal: current.principal,
      connectionEpoch: current.connectionEpoch,
    });
  } catch (error) {
    if (error instanceof HostError && error.code === 'LEASE_EXPIRED') expireCurrentAttachment();
    throw error;
  }
}
function verifier(): ExecutionGrantVerifier {
  return {
    verify: async (candidate: unknown, context: GrantContext) => {
      const grant = candidate as ExecutionGrant;
      const binding = grant && grantBindings.get(grant.grantId);
      if (
        !binding ||
        binding.principal !== context.principalId ||
        binding.elementRef?.id !== context.elementRef.id ||
        JSON.stringify(binding.effect) !== JSON.stringify(context.effect)
      )
        throw new Error('Grant 与 principal/element/effect 不匹配');
      const verified = grants.verifyAndConsume(grant, binding.expected, store);
      return { grantId: verified.grantId, expiresAt: Date.parse(verified.expiresAt) };
    },
  };
}

function availableDownloadPath(filename: string): string {
  const safeName = basename(filename.replaceAll('\\', '/')) || 'download';
  const extension = extname(safeName);
  const stem = basename(safeName, extension);
  const reserved = new Set(workspace.data.downloads.map((item) => item.savePath));
  for (let index = 0; ; index += 1) {
    const suffix = index ? ` (${index})` : '';
    const candidate = join(app.getPath('downloads'), `${stem}${suffix}${extension}`);
    if (!existsSync(candidate) && !reserved.has(candidate)) return candidate;
  }
}
function registerDownload(item: DownloadItem): void {
  const id = randomUUID();
  const savePath = availableDownloadPath(item.getFilename());
  const record: DownloadRecord = {
    id,
    filename: basename(savePath),
    url: item.getURL(),
    savePath,
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    status: 'progressing',
    startedAt: new Date().toISOString(),
  };
  item.setSavePath(savePath);
  activeDownloads.set(id, item);
  workspace.addDownload(record);
  const update = (status?: DownloadRecord['status']) => {
    const current = workspace.data.downloads.find((entry) => entry.id === id);
    if (!current) return;
    current.receivedBytes = item.getReceivedBytes();
    current.totalBytes = item.getTotalBytes();
    current.status = status ?? (item.isPaused() ? 'paused' : 'progressing');
    emit();
  };
  item.on('updated', (_event, status) =>
    update(status === 'interrupted' ? 'interrupted' : undefined),
  );
  item.on('done', (_event, status) => {
    activeDownloads.delete(id);
    update(status);
  });
  emit();
}
function requireDownload(id: string): DownloadRecord {
  const record = workspace.data.downloads.find((item) => item.id === id);
  if (!record) throw new Error('下载记录不存在');
  if (
    dirname(record.savePath) !== app.getPath('downloads') ||
    basename(record.savePath) !== record.filename
  )
    throw new Error('下载记录路径无效');
  return record;
}

async function init(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  if (process.env.NODE_ENV === 'test')
    app.setPath('downloads', join(app.getPath('userData'), 'Downloads'));
  await mkdir(app.getPath('downloads'), { recursive: true });
  try {
    agents = AgentConfigSchema.array().parse(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch {
    agents = [];
  }
  store = new DurableHostStore({ path: databasePath() });
  workspace = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'));
  try {
    await workspace.load();
  } catch (error) {
    lastError = `无法读取已有工作区：${readable(error)}`;
  }
  if (!workspace.current) workspace.create(randomUUID());
  store.reconcileExecuting({});
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: 'Pilion',
    backgroundColor: '#f7f8fa',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 12 },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/entry.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const resolver = {
    resolve: async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address),
  };
  const validateUrl = (url: string) => canonicalizeUrl(url, { resolver });
  pageFactory = new ElectronPageFactory(window, () => undefined, validateUrl);
  browser = new BrowserService({
    pageFactory,
    grantVerifier: verifier(),
    resolver,
    authorizePrincipal: authorizeBrowserPrincipal,
  });
  window.on('resize', layout);
  await configureSecurity(resolver);
  registerIpc();
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) await window.loadURL(dev);
  else await window.loadFile(join(app.getAppPath(), 'dist-renderer/index.html'));
  agentShield = new AgentShield(window);
  const restore = [...workspace.data.tabs];
  const index = workspace.data.activeTabIndex;
  for (const url of restore.length ? restore.slice(0, 30) : [HOME]) await openTab(url);
  const restored = [...pages.keys()][index];
  if (restored) activateTab(restored);
}
async function configureSecurity(resolver: {
  resolve(hostname: string): Promise<ReadonlyArray<string>>;
}): Promise<void> {
  const persistent = session.fromPartition('persist:pilion-default');
  networkProxy = new ControlledNetworkProxy({ resolver });
  const proxyAddress = await networkProxy.listen();
  const proxyUrl = `127.0.0.1:${proxyAddress.port}`;
  await persistent.setProxy({
    mode: 'fixed_servers',
    proxyRules: proxyUrl,
    proxyBypassRules: '<-loopback>',
  });
  installNetworkBoundary(persistent);
  persistent.on('will-download', (_event, item) => registerDownload(item));
  for (const target of [session.defaultSession, persistent]) {
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    target.setCertificateVerifyProc((_request, callback) => callback(-3));
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  });
}

async function executeAgentTask(text: string, resuming = false) {
  const current = requireAttachment();
  if (promptActive || connectionBusy || agentStatus !== 'ready')
    throw new Error('请等待当前任务结束');
  if (workspace.current?.agentId !== current.config.id)
    workspace.create(randomUUID(), current.config.id);
  const conversation = workspace.current!;
  if (resuming && conversation.task?.status !== 'manual') throw new Error('该任务不能继续');
  conversation.task = resuming
    ? {
        ...conversation.task!,
        status: 'running',
        agentGoalStatus: undefined,
        lastReason: undefined,
        updatedAt: new Date().toISOString(),
      }
    : {
        id: randomUUID(),
        agentId: current.config.id,
        goal: text,
        status: 'running',
        updatedAt: new Date().toISOString(),
      };
  const runningTask = conversation.task;
  promptActive = true;
  promptCancelled = false;
  activeResponseId = undefined;
  taskId = randomUUID();
  lastError = undefined;
  workspace.append({
    id: randomUUID(),
    role: 'user',
    text: text || '继续任务',
    time: new Date().toISOString(),
    status: 'completed',
  });
  agentStatus = 'running';
  emit();
  let status: ConversationMessage['status'] = 'completed';
  try {
    if (current.transport.supportsPersistentGoals) {
      runningTask.executionMode = 'goal';
      status = 'running';
      await current.transport.setGoal(runningTask.goal);
      if (resuming && text) await current.transport.prompt(text);
      return { stopReason: 'end_turn' };
    }
    runningTask.executionMode = 'prompt';
    const promptText = resuming ? text || '继续任务' : text;
    const result = await runPrompt(promptText, {
      prompt: (prompt) => current.transport.prompt(prompt),
      messages: () => conversation.messages,
      cancelled: () => promptCancelled || connection !== current,
      onResult: (result) => log(`Agent 回合结束：${result.stopReason}`),
      diagnostics: () => ({
        agent: current.transport.capabilities.agentInfo,
        trace: current.transport.traceSnapshot.slice(-24),
      }),
    });
    if (result.stopReason === 'cancelled') status = 'cancelled';
    return result;
  } catch (error) {
    if (promptCancelled) {
      status = 'cancelled';
      return { stopReason: 'cancelled' };
    }
    status = 'failed';
    if (conversation.task?.id === runningTask.id)
      conversation.task.status = error instanceof AgentEmptyResponseError ? 'manual' : 'failed';
    if (error instanceof AgentEmptyResponseError)
      log(`ACP 空响应诊断：${JSON.stringify(error.details)}`);
    lastError = readable(error);
    conversation.messages.push({
      id: randomUUID(),
      role: 'system',
      text: lastError,
      time: new Date().toISOString(),
      status,
    });
    throw error;
  } finally {
    promptActive = false;
    pageFactory.pointer.hide();
    conversation.messages = conversation.messages.filter(
      (item) => item.role !== 'assistant' || !isEmptyAgentReply(item.text),
    );
    const goalRunning =
      runningTask.executionMode === 'goal' && conversation.task?.status === 'running';
    if (!goalRunning) {
      const settledStatus: ConversationMessage['status'] =
        conversation.task?.status === 'completed'
          ? 'completed'
          : conversation.task?.status === 'manual'
            ? 'cancelled'
            : status;
      activeResponseId = undefined;
      for (const item of conversation.messages)
        if (item.status === 'running') item.status = settledStatus;
      if (conversation.task?.id === runningTask.id && conversation.task.status === 'running') {
        conversation.task.status =
          status === 'completed' ? 'completed' : status === 'cancelled' ? 'stopped' : 'failed';
        conversation.task.updatedAt = new Date().toISOString();
      }
      if (connection?.transport === current.transport && current.transport.state === 'ready')
        agentStatus = 'ready';
    } else {
      agentStatus = 'running';
    }
    emit();
  }
}

async function interruptAgent(mode: 'manual' | 'stopped') {
  const task = workspace.current?.task;
  if (task && (task.status === 'running' || task.status === 'manual')) {
    task.status = mode;
    task.updatedAt = new Date().toISOString();
  } else if (mode === 'manual') throw new Error('当前没有可接管的任务');
  emit();
  const current = connection;
  if (!current || current.transport.state !== 'ready') return;
  if (promptCancelled && !current.attachmentId) return;
  promptCancelled = true;
  if (promptActive) agentStatus = 'stopping';
  for (const message of workspace.current?.messages ?? [])
    if (message.status === 'running') message.status = 'cancelled';
  if (current.attachmentId) detachAgent();
  else browser.invalidatePrincipal(current.principal);
  pageFactory.pointer.hide();
  cancelAcpApprovals(current.transport.sessionId);
  cancelBrowserApprovals();
  log(mode === 'manual' ? '你正在操作浏览器，任务等待继续' : '任务已停止');
  const cancelledTask = taskId;
  const deadline = setTimeout(() => {
    if (promptActive && taskId === cancelledTask && connection === current)
      void failConnection(current.transport, new Error('Agent 未响应取消，连接已关闭'));
  }, 5_000);
  deadline.unref();
  const results = await Promise.allSettled([
    current.transport.cancel(),
    current.transport.clearGoal(),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') await failConnection(current.transport, failure.reason);
}

function registerIpc(): void {
  handle(IPC.getState, undefined, () => state());
  handle('agents:inspect-local', LocalInspectSchema, async (value) => ({
    ...(await inspectLocalAgents(value)),
    defaultCwd: join(app.getPath('userData'), 'workspace-files'),
  }));
  handle('agents:configure-local', LocalAgentInputSchema, async (value) => {
    if (connectionBusy || promptActive || taskRunning()) throw new Error('请等待当前任务结束');
    const cwd = value.cwd?.trim() || join(app.getPath('userData'), 'workspace-files');
    if (!value.cwd?.trim()) await mkdir(cwd, { recursive: true });
    const config = presetConfiguration(value, cwd);
    if (connection?.config.id === config.id) throw new Error('请先断开此 Agent 再修改配置');
    const existing = agents.find((item) => item.id === config.id);
    const saved = { ...existing, ...config };
    agents = [...agents.filter((item) => item.id !== config.id), saved];
    await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 });
    emit();
    return saved;
  });
  handle('agents:choose-directory', undefined, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择 Agent 工作目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  handle(IPC.viewport, ViewportSchema, (value) => {
    viewport = value;
    layout();
  });
  handle(IPC.tabOpen, UrlInputSchema, (value) => openTab(value.url));
  handle(IPC.tabActivate, IdInputSchema, (value) => activateTab(value.id));
  handle(IPC.tabClose, IdInputSchema, (value) => closeTab(value.id));
  handle(IPC.tabNavigate, NavigateInputSchema, (value) =>
    browser.navigate({ principalId: USER_PRINCIPAL, tabId: requireActiveTab(), url: value.url }),
  );
  handle(IPC.tabBack, undefined, () =>
    pages.get(requireActiveTab())!.view.webContents.navigationHistory.goBack(),
  );
  handle(IPC.tabForward, undefined, () =>
    pages.get(requireActiveTab())!.view.webContents.navigationHistory.goForward(),
  );
  handle(IPC.tabReload, undefined, () => pages.get(requireActiveTab())!.view.webContents.reload());
  handle(IPC.tabStop, undefined, () => pages.get(requireActiveTab())!.view.webContents.stop());
  handle(IPC.tabDuplicate, undefined, () => duplicateActiveTab());
  handle(IPC.tabReopenClosed, undefined, () => reopenClosedTab());
  handle(IPC.tabFind, FindInputSchema, (value) => {
    const tabId = requireActiveTab();
    if (!value.text) {
      stopFind();
      return;
    }
    activeFind = { tabId, text: value.text };
    pages.get(tabId)!.view.webContents.findInPage(value.text, {
      forward: value.forward,
      findNext: value.newSearch,
      matchCase: false,
    });
  });
  handle(IPC.tabStopFind, undefined, () => stopFind());
  handle(IPC.tabZoomIn, undefined, () => changeZoom(1));
  handle(IPC.tabZoomOut, undefined, () => changeZoom(-1));
  handle(IPC.tabZoomReset, undefined, () => changeZoom(0));
  handle(IPC.downloadTogglePause, IdInputSchema, (value) => {
    const item = activeDownloads.get(value.id);
    if (!item) throw new Error('下载已结束，无法更改状态');
    if (item.isPaused()) item.resume();
    else item.pause();
    const record = requireDownload(value.id);
    record.status = item.isPaused() ? 'paused' : 'progressing';
    emit();
  });
  handle(IPC.downloadCancel, IdInputSchema, (value) => {
    const item = activeDownloads.get(value.id);
    if (!item) throw new Error('下载已结束');
    item.cancel();
  });
  handle(IPC.downloadOpen, IdInputSchema, async (value) => {
    const record = requireDownload(value.id);
    if (record.status !== 'completed' || !existsSync(record.savePath))
      throw new Error('下载文件不存在或尚未完成');
    const failure = await shell.openPath(record.savePath);
    if (failure) throw new Error(failure);
  });
  handle(IPC.downloadShow, IdInputSchema, (value) => {
    const record = requireDownload(value.id);
    if (!existsSync(record.savePath)) throw new Error('下载文件不存在');
    shell.showItemInFolder(record.savePath);
  });
  handle(IPC.downloadClear, undefined, () => {
    workspace.data.downloads = workspace.data.downloads.filter(
      (item) => item.status === 'progressing' || item.status === 'paused',
    );
    emit();
  });
  handle(IPC.agentSave, AgentConfigInputSchema, async (config) => {
    agents = [...agents.filter((item) => item.id !== config.id), config];
    await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 });
    emit();
  });
  handle(IPC.agentRemove, IdInputSchema, async (value) => {
    if (connection?.config.id === value.id) throw new Error('请先断开此 Agent');
    agents = agents.filter((item) => item.id !== value.id);
    await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 });
    emit();
  });
  handle(IPC.agentConnect, IdInputSchema, async (value) => {
    if (connectionBusy || promptActive || taskRunning()) throw new Error('请等待当前任务结束');
    connectionBusy = true;
    try {
      await connectAgent(value.id);
    } finally {
      connectionBusy = false;
    }
  });
  handle(IPC.agentDisconnect, undefined, async () => {
    if (connectionBusy) throw new Error('连接正在变更');
    connectionBusy = true;
    try {
      await disconnectAgent();
    } finally {
      connectionBusy = false;
    }
  });
  handle(IPC.agentAttach, undefined, () => attachAgent());
  handle(IPC.agentDetach, undefined, () => detachAgent());
  handle(IPC.agentTask, TaskInputSchema, ({ text }) => executeAgentTask(text));
  handle(IPC.agentCancel, undefined, () => interruptAgent('stopped'));
  handle(IPC.agentTakeOver, undefined, () => interruptAgent('manual'));
  handle(IPC.agentResume, ResumeTaskInputSchema, async ({ text }) => {
    const task = workspace.current?.task;
    if (!task || task.status !== 'manual') throw new Error('没有等待继续的任务');
    if (promptActive || connectionBusy || taskRunning()) throw new Error('请等待 Agent 停止后继续');
    if (connection?.config.id !== task.agentId || agentStatus !== 'ready') {
      connectionBusy = true;
      try {
        await connectAgent(task.agentId);
      } finally {
        connectionBusy = false;
      }
    }
    attachAgent();
    return executeAgentTask(text, true);
  });
  handle(IPC.conversationNew, undefined, async () => {
    if (promptActive || connectionBusy || taskRunning()) throw new Error('请先结束当前任务');
    const id = connection?.config.id;
    workspace.create(randomUUID(), id);
    if (id) {
      connectionBusy = true;
      try {
        await connectAgent(id);
      } finally {
        connectionBusy = false;
      }
    }
    emit();
  });
  handle(IPC.conversationSelect, IdInputSchema, async (value) => {
    if (promptActive || connectionBusy || taskRunning()) throw new Error('请先结束当前任务');
    if (!workspace.data.conversations.some((item) => item.id === value.id))
      throw new Error('对话不存在');
    if (value.id === workspace.data.activeConversationId) return;
    connectionBusy = true;
    try {
      await disconnectAgent();
      workspace.data.activeConversationId = value.id;
    } finally {
      connectionBusy = false;
    }
    emit();
  });
  handle(IPC.bookmarkToggle, undefined, () => {
    const tab = pages.get(requireActiveTab())!.model;
    if (!/^https?:\/\//.test(tab.url)) return;
    const found = workspace.data.bookmarks.some((item) => item.url === tab.url);
    workspace.data.bookmarks = found
      ? workspace.data.bookmarks.filter((item) => item.url !== tab.url)
      : [
          ...workspace.data.bookmarks,
          { url: tab.url, title: tab.title, time: new Date().toISOString() },
        ];
    emit();
  });
  handle(IPC.historyClear, undefined, () => {
    workspace.data.history = [];
    emit();
  });
  handle('workspace:copy-message', IdInputSchema, async (value) => {
    const message = workspace.current?.messages.find((item) => item.id === value.id);
    if (!message) throw new Error('消息不存在');
    await clipboard.writeText(message.text);
  });
  handle(IPC.agentSetMode, PermissionInputSchema, async (value) => {
    if (promptActive || connectionBusy || taskRunning())
      throw new Error('请先停止当前任务再切换权限');
    connectionBusy = true;
    try {
      if (connection) await connection.transport.setPermissionMode(value.mode);
      workspace.data.permissionMode = value.mode;
      emit();
    } finally {
      connectionBusy = false;
    }
  });
  handle(IPC.agentSetModel, IdInputSchema, async (value) => {
    if (promptActive || connectionBusy || taskRunning())
      throw new Error('请先停止当前任务再切换模型');
    if (!connection) throw new Error('请先连接 Agent');
    connectionBusy = true;
    try {
      await connection.transport.setModel(value.id);
      emit();
    } finally {
      connectionBusy = false;
    }
  });
  ipcMain.handle(IPC.approvalGesture, (event, value: unknown) => {
    const parsed = ApprovalResponseSchema.pick({
      approvalId: true,
      nonce: true,
      actionDigest: true,
    }).parse(value);
    const pending = approvalSender(event, parsed.approvalId);
    if (
      parsed.approvalId !== pending.view.approvalId ||
      parsed.nonce !== pending.nonce ||
      parsed.actionDigest !== pending.actionDigest
    )
      throw new Error('审批上下文不匹配');
    const token = randomUUID();
    gestureTokens.set(token, {
      approvalId: parsed.approvalId,
      senderId: event.sender.id,
      expiresAt: Date.now() + 1_500,
    });
    return token;
  });
  ipcMain.handle(IPC.approvalRespond, (event, value: unknown) =>
    respondApproval(event, ApprovalResponseSchema.parse(value)),
  );
}
async function shutdown(): Promise<void> {
  if (draining) return;
  draining = true;
  clearTimeout(workspaceTimer);
  await workspace?.save().catch((error) => console.error('Workspace save failed', error));
  for (const pending of approvals.values()) {
    clearTimeout(pending.timer);
    if (pending.kind === 'browser') pending.reject(new Error('应用正在退出'));
    else pending.resolve({ outcome: { outcome: 'cancelled' } });
  }
  approvals.clear();
  try {
    await disconnectAgent();
  } catch {
    /* best-effort drain */
  }
  await processManager.stopAll();
  await networkProxy?.close();
  networkProxy = undefined;
  store?.close();
}
app.on('before-quit', (event) => {
  if (draining) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
void app
  .whenReady()
  .then(init)
  .catch((error) => {
    console.error(error);
    app.quit();
  });
