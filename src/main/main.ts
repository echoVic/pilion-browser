import {
  app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent, type WebContentsView,
} from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AgentProcessManager, type AgentTransport, DRAFT_CAPABILITY_SNAPSHOT,
} from './agents/index.js';
import {
  BrowserError, BrowserService, ControlledNetworkProxy, ElectronPageFactory, canonicalizeUrl, installNetworkBoundary, type BrowserEffect, type ElementRef,
  type ExecutionGrantVerifier, type GrantContext,
} from './browser/index.js';
import {
  actionDigest, canonicalCommandHash, canonicalizeCommand, classifySemanticRisk,
  DurableHostStore, evaluatePolicy, ExecutionGrantAuthority, sha256,
  type CanonicalCommandV1, type ExecutionGrant, HostError, type PolicyVerdict,
} from './host/index.js';
import {
  AgentConfigInputSchema, AgentConfigSchema, ApprovalResponseSchema, IdInputSchema, IPC,
  NavigateInputSchema, TaskInputSchema, ToolRequestSchema, UrlInputSchema,
  type AgentConfig, type AgentStatus, type AppState, type ApprovalResponse,
  type ApprovalViewState, type Tab, type ToolError, type ToolRequest,
} from '../shared/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME_HEIGHT = 112;
const PANEL_WIDTH = 360;
const HOME = 'https://example.com';
const PROFILE_ID = 'pilion-default';
const USER_PRINCIPAL = 'local-user';
const POLICY_VERSION = 'pilion-mvp-policy-v1';
const CAPABILITY_HASH = sha256(DRAFT_CAPABILITY_SNAPSHOT);
const HOST_INSTANCE_ID = randomUUID();

type PageItem = { model: Tab; view: WebContentsView };
type Connection = {
  config: AgentConfig;
  transport: AgentTransport;
  principal: string;
  sessionId: string;
  attachmentId?: string;
  connectionEpoch: number;
};
type PendingApproval = {
  view: ApprovalViewState;
  nonce: string;
  actionDigest: string;
  tabId: string;
  documentEpoch: number;
  origin: string;
  window: BrowserWindow;
  timer: NodeJS.Timeout;
  resolve: (value: { approvalDigest: string }) => void;
  reject: (error: Error) => void;
};
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
let connection: Connection | undefined;
let activeTabId: string | undefined;
let agents: AgentConfig[] = [];
let agentStatus: AgentStatus = 'not_configured';
let lastError: string | undefined;
let draining = false;
let attachmentLeaseTimer: NodeJS.Timeout | undefined;
let networkProxy: ControlledNetworkProxy | undefined;
const pages = new Map<string, PageItem>();
const events: string[] = [];
const approvals = new Map<string, PendingApproval>();
const gestureTokens = new Map<string, { approvalId: string; senderId: number; expiresAt: number }>();
const grantBindings = new Map<string, GrantBinding>();
const processManager = new AgentProcessManager();
const grants = new ExecutionGrantAuthority(randomBytes(32));

const configPath = () => join(app.getPath('userData'), 'agents.json');
const databasePath = () => join(app.getPath('userData'), 'host.sqlite');
const state = (): AppState => ({
  tabs: [...pages.values()].map(item => item.model), activeTabId, agents, agentStatus,
  attachmentStatus: connection?.attachmentId ? 'attached' : connection ? 'detached' : 'none',
  approvals: [...approvals.values()].map(item => item.view), events: events.slice(-100), error: lastError,
});
function emit(): void { if (window && !window.isDestroyed()) window.webContents.send(IPC.state, state()); }
function log(message: string): void { events.push(`${new Date().toLocaleTimeString()} ${message}`); emit(); }
function readable(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function layout(): void {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  for (const [tabId, item] of pages) {
    item.view.setBounds({ x: 0, y: CHROME_HEIGHT, width: Math.max(0, width - PANEL_WIDTH), height: Math.max(0, height - CHROME_HEIGHT) });
    item.view.setVisible(tabId === activeTabId);
  }
}
function sync(tabId: string): void {
  const item = pages.get(tabId);
  if (!item) return;
  const wc = item.view.webContents;
  item.model = {
    ...item.model, title: wc.getTitle() || '新标签页', url: wc.getURL() || item.model.url,
    loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
  emit();
}
function bindPage(tabId: string, view: WebContentsView, url: string): void {
  const item: PageItem = { model: { id: tabId, title: '新标签页', url, loading: true, canGoBack: false, canGoForward: false, crashed: false }, view };
  pages.set(tabId, item);
  view.webContents.on('did-start-loading', () => sync(tabId));
  view.webContents.on('did-stop-loading', () => sync(tabId));
  view.webContents.on('page-title-updated', () => sync(tabId));
  view.webContents.on('did-navigate', () => sync(tabId));
  view.webContents.on('did-navigate-in-page', () => sync(tabId));
  view.webContents.on('did-frame-navigate', (_event, targetUrl, _code, _status, mainFrame) => {
    if (mainFrame) staleApprovals(tabId, targetUrl);
  });
  view.webContents.on('render-process-gone', () => { item.model.crashed = true; sync(tabId); });
}
async function openTab(url = HOME): Promise<string> {
  const before = pageFactory.pages.length;
  const opened = await browser.openTab({ principalId: USER_PRINCIPAL, url });
  const createdView = pageFactory.pages[before]?.view;
  if (!createdView) throw new Error('页面适配器未创建');
  bindPage(opened.tabId, createdView, opened.url);
  if (connection?.attachmentId) grantAgentTabAcl(opened.tabId);
  activeTabId = opened.tabId;
  layout(); emit();
  return opened.tabId;
}
async function closeTab(tabId: string, principal = USER_PRINCIPAL): Promise<void> {
  await browser.closeTab(principal, tabId);
  pages.delete(tabId);
  if (activeTabId === tabId) activeTabId = pages.keys().next().value;
  layout(); emit();
  if (!pages.size && !draining) await openTab();
}
function activateTab(tabId: string, principal = USER_PRINCIPAL): void {
  browser.registry.require(tabId, principal, 'observe');
  activeTabId = tabId; layout(); emit();
}
function requireActiveTab(): string {
  if (!activeTabId || !pages.has(activeTabId)) throw new Error('没有活动标签页');
  return activeTabId;
}
function grantAgentTabAcl(tabId: string): void {
  if (!connection) return;
  browser.setTabAcl(USER_PRINCIPAL, tabId, { entries: [
    { principalId: USER_PRINCIPAL, role: 'owner' }, { principalId: connection.principal, role: 'operator' },
  ] });
}
function revokeAgentAcls(): void {
  if (connection) browser.invalidatePrincipal(connection.principal);
  for (const tabId of pages.keys()) browser.setTabAcl(USER_PRINCIPAL, tabId, { entries: [{ principalId: USER_PRINCIPAL, role: 'owner' }] });
}

function requireAttachment(): Connection & { attachmentId: string } {
  if (!connection?.attachmentId) throw new Error('Agent 尚未附加到浏览器会话');
  return connection as Connection & { attachmentId: string };
}
function dispatchOutbox(): void {
  const transport = connection?.transport;
  if (!transport || transport.state !== 'ready') return;
  for (const item of store.pendingOutbox(100)) {
    try {
      transport.notify('host/event', item.payload);
      store.acknowledgeOutbox(item.sequence);
    } catch {
      return;
    }
  }
}
function attachAgent(): void {
  const current = connection;
  if (!current) throw new Error('请先连接 Agent');
  if (current.attachmentId) return;
  const attachmentId = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  store.createAttachment({
    attachmentId, sessionId: current.sessionId, principal: current.principal, agentId: current.config.id,
    role: 'owner', leaseExpiresAt,
    connectionEpoch: current.connectionEpoch, capabilitySnapshotHash: CAPABILITY_HASH,
  });
  current.attachmentId = attachmentId;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = setTimeout(() => {
    if (connection?.attachmentId !== attachmentId) return;
    try { store.transitionAttachment(attachmentId, 'expired'); } catch { /* already terminal */ }
    expireCurrentAttachment();
  }, Math.max(0, Date.parse(leaseExpiresAt) - Date.now()));
  attachmentLeaseTimer.unref();
  for (const tabId of pages.keys()) grantAgentTabAcl(tabId);
  log('Agent 已附加；Session / Attachment / Tab ACL 生效');
  dispatchOutbox();
}
function detachAgent(): void {
  if (!connection?.attachmentId) return;
  store.transitionAttachment(connection.attachmentId, 'detached');
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  log('Agent 已分离，Tab effect 权限已撤销');
}

async function connectAgent(id: string): Promise<void> {
  await disconnectAgent();
  const config = agents.find(item => item.id === id && item.enabled);
  if (!config) throw new Error('Agent 配置不存在或已禁用');
  agentStatus = 'starting'; lastError = undefined; emit();
  const trusted = processManager.approve({ id: config.id, command: config.command, args: config.args, cwd: config.cwd, env: config.env });
  try {
    const transport = await processManager.connect(trusted);
    const sessionId = randomUUID();
    const principal = `agent:${config.id}`;
    store.createSession({ sessionId, profileId: PROFILE_ID, principal, agentId: config.id, connectionEpoch: 1, capabilitySnapshotHash: CAPABILITY_HASH });
    connection = { config, transport, principal, sessionId, connectionEpoch: 1 };
    transport.on('request', request => { void handleAgentRequest(transport, request.id, request.method, request.params); });
    transport.on('notification', notification => {
      if (notification.method === 'agent/output') log(String((notification.params as { text?: unknown })?.text ?? ''));
    });
    transport.on('stderr', value => { if (value.chunk) log(`Agent stderr: ${value.chunk.slice(0, 500)}`); });
    transport.on('protocolError', transportError => { void failConnection(transport, transportError); });
    transport.on('state', value => { if (value.current === 'closed' && connection?.transport === transport) { agentStatus = 'disconnected'; emit(); } });
    agentStatus = 'ready';
    attachAgent();
    log('pilion-acp-draft-1 Spike adapter 握手成功（非正式 ACP）');
  } catch (error) {
    agentStatus = 'error'; lastError = `Agent 连接失败：${readable(error)}`; emit(); throw error;
  }
}
async function failConnection(transport: AgentTransport, failure: unknown): Promise<void> {
  if (connection?.transport !== transport) return;
  lastError = `Agent 协议失败：${readable(failure)}`;
  agentStatus = 'error';
  const attachmentId = connection.attachmentId;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  if (attachmentId) {
    try { store.transitionAttachment(attachmentId, 'failed'); } catch { /* already terminal */ }
  }
  try { store.transitionSession(connection.sessionId, 'failed'); } catch { /* already terminal */ }
  emit();
  await transport.stop();
}
function expireCurrentAttachment(): void {
  if (!connection?.attachmentId) return;
  clearTimeout(attachmentLeaseTimer);
  attachmentLeaseTimer = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls();
  lastError = 'Attachment lease 已过期，Agent Tab ACL 已撤销';
  emit();
}
async function disconnectAgent(): Promise<void> {
  const current = connection;
  if (!current) return;
  agentStatus = 'stopping'; emit();
  if (current.attachmentId) detachAgent();
  try { store.transitionSession(current.sessionId, 'draining'); } catch { /* already terminal */ }
  await current.transport.stop();
  try { store.transitionSession(current.sessionId, 'closed'); } catch { /* already terminal */ }
  connection = undefined; agentStatus = 'disconnected'; emit();
}
async function handleAgentRequest(transport: AgentTransport, id: string | number, method: string, params: unknown): Promise<void> {
  if (method !== 'browser/tool') { transport.respondError(id, -32601, '仅允许固定 browser/tool 方法'); return; }
  try {
    const request = ToolRequestSchema.parse(params);
    const result = await executeTool(request);
    if (['ready', 'draining'].includes(transport.state)) transport.respond(id, result);
  } catch (error) {
    if (error instanceof HostError && error.code === 'LEASE_EXPIRED') expireCurrentAttachment();
    const requestId = typeof params === 'object' && params && 'requestId' in params ? String((params as { requestId: unknown }).requestId) : 'unknown';
    const toolError = toToolError(error, requestId);
    if (['ready', 'draining'].includes(transport.state)) transport.respondError(id, -32000, toolError.message, toolError);
  }
}

async function executeTool(request: ToolRequest): Promise<unknown> {
  const current = requireAttachment();
  const tabId = targetTab(request);
  const snapshot = tabId && browser.registry.has(tabId) ? await browser.registry.get(tabId).page.snapshot() : { url: HOME, title: '', loading: false };
  const elementRef = effectRef(request);
  const effect = effectFor(request);
  const trustedElement = effect && elementRef && tabId
    ? await browser.describeElement(current.principal, tabId, elementRef)
    : undefined;
  if (effect && trustedElement) validateTrustedEffectTarget(trustedElement, effect);
  const dataFlowClassifications = effect?.kind === 'type'
    ? [`text-sha256:${sha256(effect.text)}`, `text-length:${effect.text.length}`]
    : [];
  const pageOrigin = new URL(snapshot.url || HOME).origin;
  const effectDestination = trustedElement?.formAction ? safeOrigin(trustedElement.formAction) || pageOrigin : pageOrigin;
  const semanticComplete = !effect || Boolean(
    trustedElement?.role?.trim() && trustedElement.name?.trim() &&
    (effect.kind !== 'type' || trustedElement.inputType?.trim()),
  );
  const classification = classifySemanticRisk({
    operation: request.name, elementRole: trustedElement?.role, accessibleName: trustedElement?.name,
    inputType: trustedElement?.inputType, targetOrigin: effectDestination,
    changesExternalState: Boolean(effect), classifierConfident: semanticComplete,
  });
  const verdict = evaluatePolicy({ classification, policySetVersion: POLICY_VERSION, policyLoaded: true, trustedApprovalAvailable: true, contextComplete: Boolean(snapshot.url) && (!effect || Boolean(elementRef)) && semanticComplete });
  if (verdict.verdict === 'deny') throw new Error(`策略拒绝：${verdict.reasonCodes.join(', ')}`);
  const actionId = randomUUID();
  const targetEpoch = tabId && browser.registry.has(tabId) ? browser.registry.get(tabId).documentEpoch : 0;
  const command = canonicalizeCommand({
    schemaVersion: '1', tool: { name: request.name, version: '1' },
    arguments: trustedCommandArguments(request, tabId, trustedElement, effect),
    profileId: PROFILE_ID, sessionId: current.sessionId, tabId: tabId ?? 'workspace',
    target: { origin: pageOrigin, documentEpoch: String(targetEpoch), frameId: elementRef?.frameId, frameEpoch: elementRef?.frameEpoch, elementRef: elementRef?.id, localFingerprint: elementRef?.localFingerprint },
    effect: classification.effect,
    dataFlow: { source: 'agent', destination: effectDestination, classifications: dataFlowClassifications },
    obligations: verdict.obligations,
  });
  const commandHash = canonicalCommandHash(command);
  const digest = actionDigest({ command, policySetVersion: POLICY_VERSION });
  const approvalId = verdict.verdict === 'require_approval' ? randomUUID() : undefined;
  const nonce = approvalId ? randomBytes(24).toString('base64url') : undefined;
  store.createIntent({
    actionId, sessionId: current.sessionId, attachmentId: current.attachmentId, connectionEpoch: current.connectionEpoch,
    tabId: tabId ?? 'workspace', canonicalCommandHash: commandHash, actionDigest: digest, canonicalCommand: command,
    idempotencyKey: request.requestId, revisionPreconditions: command.target, policySetVersion: POLICY_VERSION,
    policyVerdict: verdict.verdict, policyReasons: verdict.reasonCodes, obligations: verdict.obligations,
    approval: approvalId && nonce ? { approvalId, nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() } : undefined,
  });
  let approvalDigest: string | undefined;
  if (approvalId && nonce) approvalDigest = (await requestApproval({
    approvalId, nonce, digest, tool: request.name, tabId: tabId!, documentEpoch: targetEpoch,
    origin: command.target.origin, summary: trustedApprovalSummary(command, trustedElement, effect),
  })).approvalDigest;
  return executePreparedAction({ request, current, command, commandHash, digest, verdict, actionId, tabId, elementRef, effect, approvalId, approvalDigest });
}

async function executePreparedAction(input: {
  request: ToolRequest; current: Connection & { attachmentId: string }; command: CanonicalCommandV1;
  commandHash: string; digest: string; verdict: PolicyVerdict; actionId: string; tabId?: string;
  elementRef?: ElementRef; effect?: BrowserEffect; approvalId?: string; approvalDigest?: string;
}): Promise<unknown> {
  const attemptId = randomUUID();
  const tabId = input.tabId ?? 'workspace';
  const prepared = store.prepareExecution({
    actionId: input.actionId, attemptId, sessionId: input.current.sessionId, attachmentId: input.current.attachmentId,
    connectionEpoch: input.current.connectionEpoch, tabId, policySetVersion: POLICY_VERSION,
    capabilitySnapshotHash: CAPABILITY_HASH, expectedApprovalDigest: input.approvalDigest,
  });
  const deadline = new Date(Date.now() + (input.request.timeoutMs ?? 15_000)).toISOString();
  const grant = grants.issue({
    hostInstanceId: HOST_INSTANCE_ID, profileId: PROFILE_ID, sessionId: input.current.sessionId,
    attachmentId: input.current.attachmentId, connectionEpoch: input.current.connectionEpoch, tabId,
    actionId: input.actionId, attemptId, canonicalCommandHash: input.commandHash, actionDigest: input.digest,
    capabilitySnapshotHash: CAPABILITY_HASH, policySetVersion: POLICY_VERSION,
    policyVerdict: input.verdict.verdict as 'allow' | 'require_approval', approvalId: input.approvalId,
    approvalDigest: input.approvalDigest, fencingToken: prepared.fencingToken, deadline,
    obligations: input.verdict.obligations.map(obligation => obligation.type === 'revalidate_target'
      ? { type: obligation.type, parameters: { documentEpoch: input.command.target.documentEpoch, frameEpoch: input.command.target.frameEpoch, localFingerprint: input.command.target.localFingerprint } }
      : obligation.type === 'trusted_approval' ? { type: obligation.type, parameters: { approvalDigest: input.approvalDigest } } : obligation),
  });
  const expected = {
    hostInstanceId: HOST_INSTANCE_ID, profileId: PROFILE_ID, sessionId: input.current.sessionId,
    attachmentId: input.current.attachmentId, connectionEpoch: input.current.connectionEpoch, tabId,
    actionId: input.actionId, attemptId, canonicalCommandHash: input.commandHash, actionDigest: input.digest,
    capabilitySnapshotHash: CAPABILITY_HASH, policySetVersion: POLICY_VERSION,
  };
  try {
    let result: unknown;
    if (input.effect && input.elementRef && input.tabId) {
      grantBindings.set(grant.grantId, { expected, principal: input.current.principal, elementRef: input.elementRef, effect: input.effect });
      const browserPrepared = await browser.prepareEffect({ principalId: input.current.principal, tabId: input.tabId, elementRef: input.elementRef, effect: input.effect, grant });
      store.markDispatched(attemptId, grant.grantId);
      store.markEffectStarted(attemptId);
      result = await browser.executePrepared({ principalId: input.current.principal, executionToken: browserPrepared.executionToken });
    } else {
      grants.verifyAndConsume(grant, expected, store);
      store.markDispatched(attemptId, grant.grantId);
      store.markEffectStarted(attemptId);
      result = await performTool(input.request, input.current.principal, input.tabId);
    }
    store.recordResult({ attemptId, outcome: 'succeeded', result });
    dispatchOutbox();
    log(`Action ${input.request.name} 已完成并写入 result/outbox`);
    return result;
  } catch (error) {
    const attempt = store.getAttempt(attemptId);
    if (attempt && ['dispatched', 'effect_started'].includes(String(attempt.state))) {
      store.recordResult({ attemptId, outcome: String(attempt.state) === 'effect_started' ? 'outcome_unknown' : 'failed', errorCode: 'EXECUTION_FAILED' });
    } else store.reconcileExecuting({ [attemptId]: 'not_consumed' });
    throw error;
  } finally { grantBindings.delete(grant.grantId); }
}

async function performTool(request: ToolRequest, principal: string, boundTabId: string | undefined): Promise<unknown> {
  const suppliedTabId = typeof request.args.tabId === 'string' ? request.args.tabId : undefined;
  if (suppliedTabId && suppliedTabId !== boundTabId) throw new Error('执行阶段 tabId 与 Intent 绑定不一致');
  const tabId = boundTabId;
  switch (request.name) {
    case 'browser.tabs.list': return browser.registry.listFor(principal).map(tab => pages.get(tab.id)?.model).filter(Boolean);
    case 'browser.tabs.open': return { tabId: await openAgentTab(principal, String(request.args.url ?? HOME)) };
    case 'browser.tabs.activate': activateTab(requireString(request.args.tabId, 'tabId'), principal); return { ok: true };
    case 'browser.tabs.close': await closeTab(requireString(request.args.tabId, 'tabId'), principal); return { ok: true };
    case 'browser.navigate': return browser.navigate({ principalId: principal, tabId: tabId!, url: requireString(request.args.url, 'url') });
    case 'browser.page_info': return browser.registry.require(tabId!, principal, 'observe').page.snapshot();
    case 'browser.observe': return browser.observe({ principalId: principal, tabId: tabId! });
    default: throw new Error('Effect tool 未进入受控 prepareEffect 路径');
  }
}
async function openAgentTab(principal: string, url: string): Promise<string> {
  const before = pageFactory.pages.length;
  const opened = await browser.openTab({ principalId: principal, url });
  const view = pageFactory.pages[before]?.view;
  if (!view) throw new Error('页面适配器未创建');
  browser.setTabAcl(principal, opened.tabId, { entries: [{ principalId: principal, role: 'owner' }, { principalId: USER_PRINCIPAL, role: 'owner' }] });
  bindPage(opened.tabId, view, opened.url); activeTabId = opened.tabId; layout(); emit(); return opened.tabId;
}

function targetTab(request: ToolRequest): string | undefined {
  if (request.name === 'browser.tabs.open' || request.name === 'browser.tabs.list') return undefined;
  return typeof request.args.tabId === 'string' ? request.args.tabId : activeTabId;
}
function trustedCommandArguments(
  request: ToolRequest,
  tabId: string | undefined,
  element: {
    role: string; name: string; disabled: boolean; tagName: string; inputType?: string;
    formAction?: string; optionValues?: ReadonlyArray<string>; checked?: boolean;
  } | undefined,
  effect: BrowserEffect | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(tabId ? { tabId } : {}) };
  if (request.name === 'browser.navigate' || request.name === 'browser.tabs.open') base.url = requireString(request.args.url ?? HOME, 'url');
  if (element) base.target = {
    role: element.role, name: element.name, disabled: element.disabled, tagName: element.tagName,
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.formAction ? { formAction: element.formAction } : {}),
    ...(element.checked === undefined ? {} : { checked: element.checked }),
  };
  if (effect?.kind === 'type') base.input = { sha256: sha256(effect.text), length: effect.text.length, replace: effect.replace !== false };
  if (effect?.kind === 'click') base.effect = 'click';
  if (effect?.kind === 'select') base.selection = { value: effect.value };
  if (effect?.kind === 'check') base.check = { checked: effect.checked };
  if (effect?.kind === 'press') base.key = { key: effect.key, modifiers: [...effect.modifiers] };
  return base;
}
function trustedApprovalSummary(
  command: CanonicalCommandV1,
  element: {
    role: string; name: string; tagName: string; inputType?: string; formAction?: string;
    optionValues?: ReadonlyArray<string>; checked?: boolean;
  } | undefined,
  effect: BrowserEffect | undefined,
): string {
  const operation = effect?.kind === 'type' ? '输入文本'
    : effect?.kind === 'click' ? '点击'
      : effect?.kind === 'select' ? `选择选项“${effect.value}”`
        : effect?.kind === 'check' ? (effect.checked ? '选中' : '取消选中')
          : effect?.kind === 'press' ? `按键 ${[...effect.modifiers, effect.key].join('+')}` : command.tool.name;
  const target = element ? `${element.role}“${element.name || '未命名元素'}”` : '页面';
  const data = effect?.kind === 'type' ? `文本 ${effect.text.length} 个字符（内容不显示，SHA-256 ${sha256(effect.text).slice(0, 12)}…）` : '无文本数据';
  const semantic = element ? `\n输入类型：${element.inputType ?? '不适用'}\n表单目标：${element.formAction ?? '当前站点'}` : '';
  return `来源：可信页面快照\n站点：${command.target.origin}\n操作：${operation}\n目标：${target}${semantic}\n数据流：Agent → ${command.dataFlow.destination}\n数据摘要：${data}`;
}
function validateTrustedEffectTarget(
  element: { disabled: boolean; tagName: string; inputType?: string; optionValues?: ReadonlyArray<string> },
  effect: BrowserEffect,
): void {
  if (element.disabled) throw new BrowserError('UNSUPPORTED_ELEMENT', '目标元素已禁用');
  if (effect.kind === 'select') {
    if (element.tagName !== 'select') throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.select 仅允许 <select>');
    if (!element.optionValues?.includes(effect.value)) throw new BrowserError('OPTION_NOT_FOUND', '目标 <select> 中不存在指定 option');
  }
  if (effect.kind === 'check' && (element.tagName !== 'input' || !['checkbox', 'radio'].includes(element.inputType ?? ''))) {
    throw new BrowserError('UNSUPPORTED_ELEMENT', 'browser.check 仅允许 checkbox/radio');
  }
  if (effect.kind === 'check' && element.inputType === 'radio' && !effect.checked) {
    throw new BrowserError('UNSUPPORTED_ELEMENT', 'radio 不支持直接取消选中');
  }
}

function effectFor(request: ToolRequest): BrowserEffect | undefined {
  if (request.name === 'browser.click') return { kind: 'click' };
  if (request.name === 'browser.type') return { kind: 'type', text: requireString(request.args.text, 'text'), replace: request.args.replace !== false };
  if (request.name === 'browser.select') return { kind: 'select', value: requireString(request.args.value, 'value') };
  if (request.name === 'browser.check') return { kind: 'check', checked: request.args.checked as boolean };
  if (request.name === 'browser.press') return {
    kind: 'press', key: request.args.key as Extract<BrowserEffect, { kind: 'press' }>['key'],
    modifiers: (request.args.modifiers ?? []) as Extract<BrowserEffect, { kind: 'press' }>['modifiers'],
  };
  return undefined;
}
function effectRef(request: ToolRequest): ElementRef | undefined {
  if (!effectFor(request)) return undefined;
  const ref = request.args.elementRef;
  if (!ref || typeof ref !== 'object') throw new Error(`${request.name} 必须携带 observe 返回的 elementRef`);
  return ref as ElementRef;
}
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function requestApproval(input: { approvalId: string; nonce: string; digest: string; tool: ToolRequest['name']; summary: string; tabId: string; documentEpoch: number; origin: string }): Promise<{ approvalDigest: string }> {
  return new Promise((resolve, reject) => {
    const approvalWindow = new BrowserWindow({
      width: 520, height: 340, parent: window, modal: true, show: false, resizable: false,
      webPreferences: { preload: join(__dirname, '../preload/approval-entry.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    approvalWindow.setMenuBarVisibility(false);
    approvalWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const view: ApprovalViewState = { approvalId: input.approvalId, tool: input.tool, summary: input.summary, state: 'pending' };
    const timer = setTimeout(() => {
      const active = approvals.get(input.approvalId);
      if (!active) return;
      try { store.resolveApproval({ approvalId: input.approvalId, nonce: input.nonce, actionDigest: input.digest, decision: 'deny', bindingValid: true }); } catch { /* already resolved */ }
      active.view.state = 'expired'; approvals.delete(input.approvalId); active.window.destroy(); active.reject(new Error('审批已过期')); emit();
    }, 60_005);
    const pending: PendingApproval = { view, nonce: input.nonce, actionDigest: input.digest, tabId: input.tabId, documentEpoch: input.documentEpoch, origin: input.origin, window: approvalWindow, timer, resolve, reject };
    approvals.set(input.approvalId, pending); emit();
    approvalWindow.once('ready-to-show', () => {
      approvalWindow.show();
      approvalWindow.webContents.send(IPC.approvalRequest, { ...view, nonce: input.nonce, actionDigest: input.digest });
    });
    approvalWindow.on('closed', () => {
      if (approvals.delete(input.approvalId)) { clearTimeout(timer); emit(); reject(new Error('审批窗口已关闭')); }
    });
    void approvalWindow.loadFile(join(app.getAppPath(), 'src/preload/approval.html'));
  });
}
function staleApprovals(tabId: string, targetUrl?: string): void {
  for (const pending of [...approvals.values()]) {
    if (pending.tabId !== tabId) continue;
    const tab = browser.registry.has(tabId) ? browser.registry.get(tabId) : undefined;
    const changed = !tab || tab.documentEpoch !== pending.documentEpoch || (targetUrl && safeOrigin(targetUrl) !== pending.origin);
    if (!changed) continue;
    try { store.resolveApproval({ approvalId: pending.view.approvalId, nonce: pending.nonce, actionDigest: pending.actionDigest, decision: 'deny', bindingValid: false }); } catch { /* already resolved */ }
    clearTimeout(pending.timer); pending.view.state = 'stale'; approvals.delete(pending.view.approvalId); pending.window.destroy(); pending.reject(new Error('页面已变化，审批已失效')); emit();
  }
}
function safeOrigin(value: string): string { try { return new URL(value).origin; } catch { return ''; } }
function approvalSender(event: IpcMainInvokeEvent): PendingApproval {
  const pending = [...approvals.values()].find(item => item.window.webContents === event.sender);
  if (!pending || event.senderFrame?.url !== pathToFileURL(join(app.getAppPath(), 'src/preload/approval.html')).href) throw new Error('拒绝非可信审批窗口或 origin');
  return pending;
}
function respondApproval(event: IpcMainInvokeEvent, response: ApprovalResponse): void {
  const pending = approvalSender(event);
  if (pending.view.approvalId !== response.approvalId || pending.nonce !== response.nonce || pending.actionDigest !== response.actionDigest) throw new Error('审批 nonce/actionDigest 绑定失败');
  const gesture = gestureTokens.get(response.gestureToken);
  gestureTokens.delete(response.gestureToken);
  if (!gesture || gesture.senderId !== event.sender.id || gesture.approvalId !== response.approvalId || gesture.expiresAt < Date.now()) throw new Error('审批缺少有效用户手势');
  const tab = browser.registry.has(pending.tabId) ? browser.registry.get(pending.tabId) : undefined;
  const currentOrigin = safeOrigin(pages.get(pending.tabId)?.view.webContents.getURL() ?? '');
  const bindingValid = Boolean(tab && tab.documentEpoch === pending.documentEpoch && currentOrigin === pending.origin);
  const resolved = store.resolveApproval({ approvalId: response.approvalId, nonce: response.nonce, actionDigest: response.actionDigest, decision: response.decision, bindingValid });
  pending.view.state = resolved.approvalState;
  clearTimeout(pending.timer); approvals.delete(response.approvalId); pending.window.destroy(); emit();
  if (resolved.approvalState === 'approved' && resolved.approvalDigest) pending.resolve({ approvalDigest: resolved.approvalDigest });
  else pending.reject(new Error(resolved.approvalState === 'stale' ? '页面已变化，审批失效' : '用户拒绝了操作'));
}

function trustedRenderer(event: IpcMainInvokeEvent): void {
  const senderFrame = event.senderFrame;
  if (!window || !senderFrame || event.sender !== window.webContents || senderFrame !== window.webContents.mainFrame) throw new Error('拒绝非可信 Renderer IPC sender/frame');
  const expected = process.env.VITE_DEV_SERVER_URL ? new URL(process.env.VITE_DEV_SERVER_URL).origin : pathToFileURL(join(app.getAppPath(), 'dist-renderer/index.html')).href;
  if (process.env.VITE_DEV_SERVER_URL ? new URL(senderFrame.url).origin !== expected : senderFrame.url !== expected) throw new Error('拒绝非可信 Renderer origin');
}
function handle<T>(channel: string, schema: { parse(value: unknown): T } | undefined, fn: (value: T) => unknown): void {
  ipcMain.handle(channel, (event, value) => { trustedRenderer(event); return fn(schema ? schema.parse(value) : value as T); });
}
function authorizeBrowserPrincipal(principalId: string): void {
  if (principalId === USER_PRINCIPAL) return;
  const current = connection;
  if (!current?.attachmentId || current.principal !== principalId || current.transport.state !== 'ready') {
    throw new HostError('INVALID_STATE_TRANSITION', 'Agent attachment is no longer active');
  }
  try {
    store.assertAttachmentAccess({
      sessionId: current.sessionId, attachmentId: current.attachmentId,
      principal: current.principal, connectionEpoch: current.connectionEpoch,
    });
  } catch (error) {
    if (error instanceof HostError && error.code === 'LEASE_EXPIRED') expireCurrentAttachment();
    throw error;
  }
}
function verifier(): ExecutionGrantVerifier {
  return { verify: async (candidate: unknown, context: GrantContext) => {
    const grant = candidate as ExecutionGrant;
    const binding = grant && grantBindings.get(grant.grantId);
    if (!binding || binding.principal !== context.principalId || binding.elementRef?.id !== context.elementRef.id || JSON.stringify(binding.effect) !== JSON.stringify(context.effect)) throw new Error('Grant 与 principal/element/effect 不匹配');
    const verified = grants.verifyAndConsume(grant, binding.expected, store);
    return { grantId: verified.grantId, expiresAt: Date.parse(verified.expiresAt) };
  } };
}

async function init(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  try { agents = AgentConfigSchema.array().parse(JSON.parse(await readFile(configPath(), 'utf8'))); } catch { agents = []; }
  store = new DurableHostStore({ path: databasePath() });
  store.reconcileExecuting({});
  window = new BrowserWindow({
    width: 1440, height: 900,
    webPreferences: { preload: join(__dirname, '../preload/entry.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const resolver = { resolve: async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address) };
  const validateUrl = (url: string) => canonicalizeUrl(url, { resolver });
  pageFactory = new ElectronPageFactory(window, () => undefined, validateUrl);
  browser = new BrowserService({ pageFactory, grantVerifier: verifier(), resolver, authorizePrincipal: authorizeBrowserPrincipal });
  window.on('resize', layout);
  await configureSecurity(resolver);
  registerIpc();
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) await window.loadURL(dev); else await window.loadFile(join(app.getAppPath(), 'dist-renderer/index.html'));
  await openTab();
}
async function configureSecurity(resolver: { resolve(hostname: string): Promise<ReadonlyArray<string>> }): Promise<void> {
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
  for (const target of [session.defaultSession, persistent]) {
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    target.setCertificateVerifyProc((_request, callback) => callback(-3));
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  });
}

function registerIpc(): void {
  handle(IPC.getState, undefined, () => state());
  handle(IPC.tabOpen, UrlInputSchema, value => openTab(value.url));
  handle(IPC.tabActivate, IdInputSchema, value => activateTab(value.id));
  handle(IPC.tabClose, IdInputSchema, value => closeTab(value.id));
  handle(IPC.tabNavigate, NavigateInputSchema, value => browser.navigate({ principalId: USER_PRINCIPAL, tabId: requireActiveTab(), url: value.url }));
  handle(IPC.tabBack, undefined, () => pages.get(requireActiveTab())!.view.webContents.navigationHistory.goBack());
  handle(IPC.tabForward, undefined, () => pages.get(requireActiveTab())!.view.webContents.navigationHistory.goForward());
  handle(IPC.tabReload, undefined, () => pages.get(requireActiveTab())!.view.webContents.reload());
  handle(IPC.agentSave, AgentConfigInputSchema, async config => { agents = [...agents.filter(item => item.id !== config.id), config]; await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 }); emit(); });
  handle(IPC.agentConnect, IdInputSchema, value => connectAgent(value.id));
  handle(IPC.agentDisconnect, undefined, () => disconnectAgent());
  handle(IPC.agentAttach, undefined, () => attachAgent());
  handle(IPC.agentDetach, undefined, () => detachAgent());
  handle(IPC.agentTask, TaskInputSchema, async value => { const current = requireAttachment(); agentStatus = 'running'; emit(); try { return await current.transport.request('agent/task', { text: value.text }); } finally { agentStatus = 'ready'; emit(); } });
  handle(IPC.agentCancel, undefined, () => { if (connection?.transport.state === 'ready') connection.transport.notify('agent/cancel', {}); });
  ipcMain.handle(IPC.approvalGesture, (event, value: unknown) => {
    const pending = approvalSender(event);
    const parsed = ApprovalResponseSchema.pick({ approvalId: true, nonce: true, actionDigest: true }).parse(value);
    if (parsed.approvalId !== pending.view.approvalId || parsed.nonce !== pending.nonce || parsed.actionDigest !== pending.actionDigest) throw new Error('审批上下文不匹配');
    const token = randomUUID(); gestureTokens.set(token, { approvalId: parsed.approvalId, senderId: event.sender.id, expiresAt: Date.now() + 1_500 }); return token;
  });
  ipcMain.handle(IPC.approvalRespond, (event, value: unknown) => respondApproval(event, ApprovalResponseSchema.parse(value)));
}
function toToolError(error: unknown, requestId: string): ToolError {
  const text = readable(error);
  if (error instanceof BrowserError) {
    return { code: error.code, message: text, retryable: error.retryable, requestId };
  }
  if (error instanceof ZodError) return { code: 'INVALID_ARGUMENT', message: text, retryable: false, requestId };
  const code: ToolError['code'] = /stale|失效|变化/i.test(text) ? 'STALE_ELEMENT' : /permission|权限|附加/i.test(text) ? 'PERMISSION_DENIED' : /策略/.test(text) ? 'POLICY_DENIED' : /tab|标签/.test(text) ? 'TAB_NOT_FOUND' : 'INTERNAL_ERROR';
  return { code, message: text, retryable: ['STALE_ELEMENT', 'ACTION_TIMEOUT'].includes(code), requestId };
}

async function shutdown(): Promise<void> {
  if (draining) return;
  draining = true;
  for (const pending of approvals.values()) { clearTimeout(pending.timer); pending.reject(new Error('应用正在退出')); pending.window.destroy(); }
  approvals.clear();
  try { await disconnectAgent(); } catch { /* best-effort drain */ }
  await processManager.stopAll();
  await networkProxy?.close();
  networkProxy = undefined;
  store?.close();
}
app.on('before-quit', event => {
  if (draining) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
void app.whenReady().then(init).catch(error => { console.error(error); app.quit(); });
