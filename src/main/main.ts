import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  session,
  shell,
  type BaseWindow,
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
import { execFile } from 'node:child_process';
import {
  chromeCookieKey,
  chromeProfiles,
  chromeSafeStorageSecret,
  readChromeCookies,
} from './browser/chrome-cookies.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceStore } from './workspace.js';
import { SettingsStore } from './settings-store.js';
import { createSettingsWindow } from './settings-window.js';
import { assertDownloadDirectory, downloadLocation, isDownloadPathAllowed } from './downloads.js';
import { buildMenu, type MenuState } from './menu.js';
import { restartInterrupts, UpdateController } from './updater.js';
import { getDefaultBrowserStatus, setDefaultBrowser } from './default-browser.js';
import { ExternalUrlQueue } from './external-urls.js';
import { AppSettingsPatchSchema } from '../shared/settings.js';
import { interceptedShortcut, type AppAction } from '../shared/keybindings.js';
import { AgentShield } from './browser/agent-shield.js';
import { AgentEmptyResponseError, isEmptyAgentReply, runPrompt } from './agents/prompt-runner.js';
import { AttachmentLease, ATTACHMENT_IDLE_MS } from './host/attachment-lease.js';
import { executionFailureResult } from './host/execution-failure.js';
import { sshLaunch } from './agents/ssh.js';
import {
  inspectLocalAgents,
  presetConfiguration,
  resolveLocalLaunch,
  abortAdapterInstalls,
} from './agents/local-agents.js';
import {
  BrowsingDataClearSchema,
  type BrowsingDataClearInput,
  type BrowsingDataClearResult,
  ChromeCookieImportSchema,
  LocalAgentInputSchema,
  LocalInspectSchema,
} from '../shared/contracts.js';
import {
  AgentProcessManager,
  type AgentGoalSnapshot,
  type AgentTransport,
  BrowserMcpHost,
} from './agents/index.js';
import { MAX_CONCURRENT_SESSIONS, SessionRuntimeRegistry } from './agents/session-runtime.js';
import { BackgroundTabWakeManager } from './browser/background-tabs.js';
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
import { ExternalControlServer } from './external/server.js';
import {
  externalPrincipal,
  type ExternalConnection,
  type ExternalRuntime,
} from './external/types.js';
import {
  DistillationState,
  MAX_EVENTS,
  RecordingLibrary,
  RENDER_EVENTS_LIMIT,
  StepSchema,
  buildDistillPrompt,
  createRecordingSession,
  describeStep,
  playSteps,
  renderEvents,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
  type PlayOutcome,
  type RecordingSummary,
  type Skill,
  type Step,
  type Trajectory,
} from './recording/index.js';
import { SkillProposalState } from './recording/proposals.js';
import { promptContents } from '../shared/attachments.js';
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
  PreferencesTargetSchema,
  RecordingNoteSchema,
  RecordingStopSchema,
  SkillEventsArgsSchema,
  SkillPlaySchema,
  SkillRenameSchema,
  SkillSaveSchema,
  SkillProposalApplySchema,
  SkillProposalDiscardSchema,
  SkillsPlayArgsSchema,
  ToolRequestSchema,
  type PromptAttachment,
  type ReplayState,
  type SkillDetail,
  type SkillStepView,
  type AgentConfig,
  type AgentActivityPhase,
  type ChromeCookieImportResult,
  type ChromeCookieSources,
  type AgentStatus,
  type AppState,
  type AdapterInstallState,
  type ApprovalResponse,
  type ApprovalViewState,
  type Tab,
  type ToolRequest,
  type BrowserViewport,
  type Conversation,
  type ConversationMessage,
  type DownloadRecord,
  type FindResult,
  type PreferencesTarget,
} from '../shared/contracts.js';
import {
  describeRule,
  previewRuns,
  ScheduleInputSchema,
  SchedulePreviewSchema,
  ScheduleSetEnabledSchema,
  type ScheduleInput,
  type ScheduleOrigin,
  type ScheduledPrompt,
} from '../shared/schedule.js';
import { SchedulesStore, ScheduleLimitError } from './schedule/store.js';
import { SchedulerEngine } from './schedule/engine.js';
import type { ScheduledPromptRunner } from './schedule/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = 'about:blank';
const PROFILE_ID = 'pilion-default';
const USER_PRINCIPAL = 'local-user';
const POLICY_VERSION = 'pilion-mvp-policy-v1';
const HOST_INSTANCE_ID = randomUUID();
/**
 * A turn that sends nothing for this long, with nothing waiting on Pilion, counts as silent. The e2e
 * suite shortens it with PILION_PROMPT_IDLE_MS, which is ignored outside NODE_ENV=test.
 */
const PROMPT_IDLE_MS =
  (process.env.NODE_ENV === 'test' ? Number(process.env.PILION_PROMPT_IDLE_MS) : 0) || 5 * 60_000;

type PageItem = { model: Tab; view: WebContentsView; pendingUrl?: string };
type Connection = {
  conversationId: string;
  config: AgentConfig;
  transport: AgentTransport;
  mcpHost: BrowserMcpHost;
  principal: string;
  sessionId: string;
  capabilitySnapshotHash: string;
  attachmentId?: string;
  connectionEpoch: number;
  /** 本会话独立的运行态：prompt/工具在飞、当前 task、回合里的回复 id、本会话的 Agent 标签。 */
  promptActive: boolean;
  promptCancelled: boolean;
  connectionBusy: boolean;
  toolExecutions: number;
  taskId?: string;
  activeResponseId?: string;
  agentTabId?: string;
  attachmentLease?: AttachmentLease;
};

/** 每个对话一条连接：transport + MCP host + principal + attachment 各自独立，可并行运行。 */
const sessions = new Map<string, Connection>();
/** 用 WeakMap 把某个 transport 的事件路由回它自己的连接，避免用单例 connection 串会话。 */
const transportSessions = new WeakMap<AgentTransport, Connection>();

function conversationById(id: string): Conversation | undefined {
  return workspace.data.conversations.find((item) => item.id === id);
}
/** runTool 需要的最小身份：Agent 连接与人工回放的本地 principal 都满足它。 */
type Actor = {
  principal: string;
  sessionId: string;
  attachmentId: string;
  connectionEpoch: number;
  capabilitySnapshotHash: string;
  /** Agent 回放技能时每一步携带的那次审批；有它就不再逐步问人，只做目标重校验。 */
  replayApproval?: string;
};
type PendingBrowserApproval = {
  kind: 'browser';
  view: ApprovalViewState;
  nonce: string;
  actionDigest: string;
  tabId: string;
  documentEpoch: number;
  origin: string;
  conversationId: string;
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
  conversationId: string;
  timer: NodeJS.Timeout;
  allowOptionId?: string;
  rejectOptionId?: string;
  resolve: (value: RequestPermissionResponse) => void;
};
/** browser.schedule.create 的用户审批：与页面无关，只是让人确认「真的要建这条定时任务」。 */
type PendingScheduleApproval = {
  kind: 'schedule';
  view: ApprovalViewState;
  nonce: string;
  actionDigest: string;
  timer: NodeJS.Timeout;
  /** 定时任务审批不属于某个对话，面板上不过滤会话。 */
  conversationId?: string;
  resolve: (approved: boolean) => void;
};
type PendingApproval = PendingBrowserApproval | PendingAcpApproval | PendingScheduleApproval;
type GrantBinding = {
  expected: Parameters<ExecutionGrantAuthority['verifyAndConsume']>[1];
  principal: string;
  elementRef?: ElementRef;
  effect?: BrowserEffect;
};

let window: BrowserWindow;
let settingsWindow: BrowserWindow | undefined;
let store: DurableHostStore;
let browser: BrowserService;
let pageFactory: ElectronPageFactory;
let agentShield: AgentShield | undefined;
let connection: Connection | undefined;
let activeTabId: string | undefined;
/**
 * Agent 这次任务正在操作的那个标签页，用来在侧栏给别人看的「AI 操作中」标识。
 * 人自己切走不改它：标识跟着 Agent 最近一次操作走，而不是跟着活动标签走。
 */
let agentTabId: string | undefined;
let agents: AgentConfig[] = [];
let agentStatus: AgentStatus = 'not_configured';
let lastError: string | undefined;
const externalUrls = new ExternalUrlQueue(openExternalUrl, (error) => {
  lastError = readable(error);
  emit();
});
let draining = false;
let attachmentLease: AttachmentLease | undefined;
let networkProxy: ControlledNetworkProxy | undefined;
let workspace: WorkspaceStore;
let settings: SettingsStore;
/** 打包后的应用才有；开发模式和 e2e 里一直是 undefined，状态显示为 unsupported。 */
let updates: UpdateController | undefined;
/** 「立即重启」收尾完、交给安装程序之后为 true：窗口关完时不再自己退出，由更新程序退出 Pilion。 */
let installingUpdate = false;
/** before-quit 一开始就置位：关窗时据此区分「退出」和「只是把窗口藏起来」。 */
let quitting = false;
let menuSignature: string | undefined;
/** 设置窗口是从主窗口的 Agent 入口打开的：在那里连上之后收起它，回到浏览器。 */
let returnAfterConnect = false;
/** 最近一次要求设置窗口停在哪；窗口还在加载时被再次打开，加载完发的是这一次。 */
let preferencesTarget: PreferencesTarget = {};
let workspaceTimer: NodeJS.Timeout | undefined;
let viewport: BrowserViewport = { x: 236, y: 88, width: 804, height: 780, visible: true };
let connectionBusy = false;
let promptActive = false;
let toolExecutions = 0;
let restoreReadyAfterTools = false;
/** 定时任务：持久化存储 + 调度器。runner 见 scheduledRunner。 */
let schedules: SchedulesStore | undefined;
let scheduler: SchedulerEngine | undefined;
/** 当前由定时任务触发、正在跑的 scheduleId（isRunning 用；单活跃模型下至多一个）。 */
let scheduledRunId: string | undefined;
let promptCancelled = false;
let library: RecordingLibrary;
/**
 * 录制的全部状态都在会话里，主进程只从这里读。
 * browser / library / store 是初始化时才赋值的，所以一律用转发函数取，不在建会话时就读。
 */
const recordingSession = createRecordingSession({
  browser: {
    registry: {
      has: (tabId) => browser.registry.has(tabId),
      get: (tabId) => browser.registry.get(tabId),
    },
    observe: (input) => browser.observe(input),
  },
  library: { create: (name, trajectory, events) => library.create(name, trajectory, events) },
  recordEvent: (tabId, eventType, payload) =>
    store.recordEvent('recording', tabId, eventType, payload),
  emit: () => emit(),
  log: (line) => log(line),
  busy: () => recordingBusyReason(),
  principalId: USER_PRINCIPAL,
});
let skills: RecordingSummary[] = [];
let localSession: { sessionId: string; capabilitySnapshotHash: string } | undefined;

/** 人工回放用的 Host 身份：一次会话一个 session，一次回放一个 attachment，台账里与 Agent 分得开。 */
function acquireLocalActor(): Actor & { release(): void } {
  if (!localSession) {
    const sessionId = randomUUID();
    const capabilitySnapshotHash = sha256('local-replay');
    store.createSession({
      sessionId,
      profileId: PROFILE_ID,
      principal: USER_PRINCIPAL,
      agentId: 'local-user',
      connectionEpoch: 1,
      capabilitySnapshotHash,
    });
    localSession = { sessionId, capabilitySnapshotHash };
  }
  const attachmentId = randomUUID();
  store.createAttachment({
    attachmentId,
    sessionId: localSession.sessionId,
    principal: USER_PRINCIPAL,
    agentId: 'local-user',
    role: 'owner',
    leaseExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    connectionEpoch: 1,
    capabilitySnapshotHash: localSession.capabilitySnapshotHash,
  });
  return {
    principal: USER_PRINCIPAL,
    sessionId: localSession.sessionId,
    attachmentId,
    connectionEpoch: 1,
    capabilitySnapshotHash: localSession.capabilitySnapshotHash,
    release: () => {
      try {
        store.transitionAttachment(attachmentId, 'detached');
      } catch {
        /* already terminal */
      }
    },
  };
}

/** 对外 CLI / MCP 的本地 Unix socket；只有设置里开启时才监听。 */
let externalServer: ExternalControlServer | undefined;

/** 活动中的外部 attachment：authorizeBrowserPrincipal 按它校验外部 principal，而不是全局 agent 连接。 */
const externalAttachments = new Map<
  string,
  { principal: string; sessionId: string; attachmentId: string; connectionEpoch: number; capabilitySnapshotHash: string }
>();

const externalRuntime: ExternalRuntime = {
  isEnabled: () => settings.data.externalControl,
  admit: admitExternalConnection,
  recordEvent: (eventType, payload) =>
    store.recordEvent('external', eventType, eventType, payload),
};

/**
 * 一次外部连接在 Host 里固化身份：独立 session + attachment + lease，principal = `external:<client>`。
 * token 在 accept 时已校验通过，client 只是身份标签；之后每一次工具调用都用这同一个 attachment 记账。
 */
function admitExternalConnection(client: string): ExternalConnection {
  const principal = externalPrincipal(client);
  const agentId = `external:${client}`;
  const sessionId = randomUUID();
  const capabilitySnapshotHash = sha256(`external:${client}`);
  store.createSession({
    sessionId,
    profileId: PROFILE_ID,
    principal,
    agentId,
    connectionEpoch: 1,
    capabilitySnapshotHash,
  });
  const attachmentId = randomUUID();
  store.createAttachment({
    attachmentId,
    sessionId,
    principal,
    agentId,
    role: 'owner',
    leaseExpiresAt: new Date(Date.now() + ATTACHMENT_IDLE_MS).toISOString(),
    connectionEpoch: 1,
    capabilitySnapshotHash,
  });
  const actor: Actor = {
    principal,
    sessionId,
    attachmentId,
    connectionEpoch: 1,
    capabilitySnapshotHash,
  };
  externalAttachments.set(attachmentId, {
    principal,
    sessionId,
    attachmentId,
    connectionEpoch: 1,
    capabilitySnapshotHash,
  });
  // 同名 principal 会继承上一条连接留下的 Tab ACL：这是「同名即同身份」信任模型，必须显式留痕。
  const inheritedTabs = browser.registry.listFor(principal).length;
  if (inheritedTabs > 0) {
    store.recordEvent('external', 'external.principal.acl_inherited', 'external.principal.acl_inherited', {
      principal,
      attachmentId,
      inheritedTabs,
    });
  }
  let closed = false;
  let aclStripped = false;
  const lease = new AttachmentLease({
    leaseExpiresAt: Date.now() + ATTACHMENT_IDLE_MS,
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
    isActive: () => !closed,
    renew: (deadline) => store.renewAttachment(attachmentId, new Date(deadline).toISOString()),
    expire: () => closeExternalConnection(),
  });
  function stripOwnAcl(): void {
    if (aclStripped) return;
    aclStripped = true;
    // 只摘掉这个 principal 自己的 Tab ACL entry，不重写整表；它开过的标签仍留给用户。
    browser.revokePrincipal(principal);
  }
  function closeExternalConnection(): void {
    if (closed) return;
    closed = true;
    lease.stop();
    externalAttachments.delete(attachmentId);
    try {
      store.transitionAttachment(attachmentId, 'detached');
    } catch {
      /* already terminal */
    }
    // 普通断开：只中止这个 principal 的在途操作，ACL 保留——同一个 principal 下次连上还能看到自己开的标签。
    browser.invalidatePrincipal(principal);
    emit();
  }
  return {
    principal,
    client,
    connectedAt: new Date().toISOString(),
    attachmentId,
    run: (request) => {
      if (closed) return Promise.reject(new Error('外部连接已关闭'));
      lease.activity();
      return executeTool(request, actor);
    },
    close: closeExternalConnection,
    revoke: () => {
      stripOwnAcl();
      closeExternalConnection();
    },
  };
}

function startExternalControl(): void {
  if (externalServer?.isListening) return;
  externalServer = new ExternalControlServer({
    dir: join(app.getPath('userData'), 'external'),
    runtime: externalRuntime,
    command: process.execPath,
    mcpClientPath: join(__dirname, 'external/pilion-mcp.js'),
  });
  externalServer
    .start()
    .then(() => emit())
    .catch((error) => {
      lastError = `外部控制通道启动失败：${readable(error)}`;
      emit();
    });
}

async function stopExternalControl(): Promise<void> {
  const server = externalServer;
  externalServer = undefined;
  if (server) await server.stop();
}

type ActiveReplay = {
  id: string;
  steps: Step[];
  actor: ReturnType<typeof acquireLocalActor>;
  abort: AbortController;
  state: ReplayState;
};
let replay: ActiveReplay | undefined;
/** 占位到 replay 真正赋值为止：startReplay 在第一个 await 前就把名额占住。 */
let replayStarting = false;
/** 提炼的状态机：名额、进行中那一轮、待人定夺的提案、上一次的拒绝理由都在它手里。 */
const distillation = new DistillationState({
  // library 与 store 要等 init() 才有，所以这里只留一层转发，不在模块求值时就取。
  library: { writeSkill: (id, prose, skill) => library.writeSkill(id, prose, skill) },
  recordEvent: (id, eventType, payload) => store.recordEvent('skill', id, eventType, payload),
  emit,
  refreshSkills,
  log,
});
/** 普通聊天回合里 Agent 顺手吐出的技能块：只提案、待人确认，写盘仍过编辑分权校验。 */
const skillProposals = new SkillProposalState({
  library: {
    hasSkill: (id) => library.hasSkill(id),
    readSkill: (id) => library.readSkill(id),
    writeSkill: (id, prose, skill) => library.writeSkill(id, prose, skill),
  },
  recordEvent: (id, eventType, payload) => store.recordEvent('skill', id, eventType, payload),
  emit,
  refreshSkills,
  log,
});
/** 一次调用能播多久：MCP 桥 90s 就把这通调用判超时，播放器必须先于它收手。 */
const AGENT_REPLAY_BUDGET_MS = 80_000;
/** Agent 通过 MCP 回放技能时的进度与取消句柄；人的回放用 replay，两者互斥。 */
let agentReplay: { name: string; step: number; total: number; abort: AbortController } | undefined;
/** 占位到 agentReplay 真正赋值为止：审批要等人，这段时间名额也得占住。 */
let agentReplayStarting = false;
/** 任务 id → 已审批的技能步骤哈希；技能一改哈希就变，重新问。 */
const approvedSkills = new Map<string, Set<string>>();
/** runTool 到 performTool 之间传递已加载的技能。 */
const pendingSkillPlays = new Map<
  string,
  { skill: Skill; fromStep: number; approvalId?: string; actor: Actor }
>();

function replayRunning(): boolean {
  return replay?.state.status === 'running';
}

async function startReplay(id: string, fromStep = 1): Promise<void> {
  if (replayStarting || replayRunning()) throw new Error('已有技能在回放');
  if (agentReplayStarting || agentReplay) throw new Error('Agent 正在回放技能');
  if (recordingSession.isRecording()) throw new Error('正在录制，无法回放');
  if (distillation.active) throw new Error('正在提炼，请稍后');
  if (isAgentBrowserActive() || promptActive || taskRunning())
    throw new Error('Agent 正在执行任务，无法回放');
  replayStarting = true;
  let active: ActiveReplay;
  try {
    requireActiveTab();
    const { trajectory } = await library.read(id);
    const steps = trajectory.entries.flatMap((entry) =>
      entry.kind === 'step' ? [entry.step] : [],
    );
    if (!steps.length) throw new Error('这份录制没有可回放的步骤');
    if (fromStep > steps.length) throw new Error('起始步骤超出范围');
    replay?.actor.release();
    const actor = acquireLocalActor();
    active = {
      id,
      steps,
      actor,
      abort: new AbortController(),
      state: {
        id,
        name: trajectory.meta.name,
        step: fromStep,
        total: steps.length,
        status: 'running',
      },
    };
    replay = active;
    store.recordEvent('replay', id, 'replay.started', {
      fromStep,
      attachmentId: actor.attachmentId,
    });
    log(`开始回放：${trajectory.meta.name}`);
    emit();
  } finally {
    replayStarting = false;
  }
  void runReplay(active, fromStep);
}

async function runReplay(active: ActiveReplay, fromStep: number): Promise<void> {
  const outcome: PlayOutcome = await playSteps(active.steps, {
    fromStep,
    signal: active.abort.signal,
    // 页面状态只是读一眼，走不着意图与台账那一整套；settle 每 200ms 问一次。
    probe: async () => {
      const tabId = requireActiveTab();
      if (!browser.registry.has(tabId)) throw new Error('没有活动标签页');
      return browser.registry.get(tabId).page.snapshot();
    },
    execute: (name, args) =>
      executeTool(
        ToolRequestSchema.parse({ requestId: randomUUID(), name, args, timeoutMs: 15_000 }),
        active.actor,
      ),
    onProgress: (step) => {
      active.state.step = step;
      emit();
    },
  }).catch((error): PlayOutcome => ({
    ok: false,
    reason: 'EFFECT_FAILED',
    failedAt: active.state.step,
    step: '',
    url: '',
    title: '',
    remaining: [],
    message: readable(error),
  }));
  if (replay !== active) return;
  if (outcome.ok) {
    active.state.status = 'done';
    active.state.step = outcome.steps;
    active.state.message = undefined;
  } else if (outcome.reason === 'HUMAN') {
    active.state.status = 'paused';
    active.state.message = outcome.humanReason;
    active.state.nextStep = outcome.at + 1;
  } else if (outcome.reason === 'CANCELLED') {
    active.state.status = 'failed';
    active.state.message = '已停止';
  } else {
    active.state.status = 'failed';
    active.state.message = `第 ${outcome.failedAt} 步失败（${outcome.reason}）：${outcome.step}${
      outcome.message ? ` — ${outcome.message}` : ''
    }`;
  }
  store.recordEvent('replay', active.id, `replay.${active.state.status}`, {
    step: active.state.step,
    reason: outcome.ok ? undefined : outcome.reason,
  });
  if (active.state.status !== 'paused') active.actor.release();
  log(
    active.state.status === 'done'
      ? `回放完成：${active.state.name}`
      : active.state.status === 'paused'
        ? `回放暂停，需要你：${active.state.message}`
        : `回放失败：${active.state.message}`,
  );
  emit();
}

function resumeReplay(): void {
  const active = replay;
  if (!active || active.state.status !== 'paused' || !active.state.nextStep)
    throw new Error('没有等待继续的回放');
  if (recordingSession.isRecording()) throw new Error('正在录制，无法回放');
  if (isAgentBrowserActive() || promptActive || taskRunning())
    throw new Error('Agent 正在执行任务，无法回放');
  if (active.state.nextStep > active.steps.length) {
    active.state.status = 'done';
    active.state.step = active.steps.length;
    active.actor.release();
    emit();
    return;
  }
  active.state.status = 'running';
  active.state.step = active.state.nextStep;
  active.state.message = undefined;
  emit();
  void runReplay(active, active.state.nextStep);
}

/** 运行中：中止；已结束：收起。两种情况都释放本地 attachment。 */
function stopReplay(): void {
  const active = replay;
  if (!active) return;
  if (active.state.status === 'running') {
    active.abort.abort();
    // 中止要等当前这一步让出，在那之前先让界面说一声。
    active.state.message = '正在停止';
    emit();
    return;
  }
  active.actor.release();
  replay = undefined;
  emit();
}

/** Agent 的回放：每一步仍是它自己的 ToolRequest，记在它的 attachment 下；卡住就交还给人。 */
async function playSkillForAgent(
  skillId: string,
  play: { skill: Skill; fromStep: number; approvalId?: string },
  actor: Actor,
): Promise<unknown> {
  const abort = new AbortController();
  agentReplay = {
    name: play.skill.meta.name,
    step: play.fromStep,
    total: play.skill.steps.length,
    abort,
  };
  store.recordEvent('replay', skillId, 'replay.started', {
    fromStep: play.fromStep,
    attachmentId: actor.attachmentId,
    approvalId: play.approvalId,
    by: 'agent',
  });
  emit();
  try {
    const outcome = await playSteps(play.skill.steps, {
      fromStep: play.fromStep,
      signal: abort.signal,
      budgetMs: AGENT_REPLAY_BUDGET_MS,
      probe: async () => {
        const tabId = requireActiveTab();
        if (!browser.registry.has(tabId)) throw new Error('没有活动标签页');
        return browser.registry.get(tabId).page.snapshot();
      },
      execute: async (name, args) => {
        const requestId = randomUUID();
        store.recordEvent('replay', skillId, 'replay.step', {
          step: agentReplay?.step,
          requestId,
          approvalId: play.approvalId,
        });
        return executeTool(ToolRequestSchema.parse({ requestId, name, args, timeoutMs: 15_000 }), {
          ...actor,
          replayApproval: play.approvalId ?? 'approved-earlier',
        });
      },
      onProgress: (step) => {
        if (agentReplay) agentReplay.step = step;
        emit();
      },
    });
    store.recordEvent(
      'replay',
      skillId,
      `replay.${outcome.ok ? 'done' : outcome.reason === 'HUMAN' ? 'paused' : 'failed'}`,
      {
        by: 'agent',
        reason: outcome.ok ? undefined : outcome.reason,
      },
    );
    if (!outcome.ok && outcome.reason === 'HUMAN') {
      const task = workspace.current?.task;
      // 最后一步就是人做的：没有下一步可续，留了游标反而让 Agent 去播一个越界的 fromStep。
      if (task && outcome.at < play.skill.steps.length)
        task.replayCursor = { skillId, name: play.skill.meta.name, nextStep: outcome.at + 1 };
      if (connection) pauseForHuman(connection, outcome.humanReason);
      return {
        ...outcome,
        message: '浏览器已交回用户，请结束本回合；用户继续后从 fromStep 续播。',
      };
    }
    if (!outcome.ok && outcome.reason === 'TIMEOUT')
      return {
        ...outcome,
        message: '单次调用预算用尽，这一步尚未执行；用 fromStep = failedAt 续播。',
      };
    return outcome;
  } finally {
    agentReplay = undefined;
    agentReplayStarting = false;
    emit();
  }
}

/** 提炼：一个专属对话里跑一次普通 prompt，主进程取块、校验、对账；人按保留才落盘。 */
async function startDistillation(id: string): Promise<void> {
  const current = connection;
  if (!current || current.transport.state !== 'ready') throw new Error('请先连接 Agent');
  if (promptActive || connectionBusy || taskRunning()) throw new Error('请等待当前任务结束');
  if (recordingSession.isRecording()) throw new Error('正在录制，无法提炼');
  if (replayRunning()) throw new Error('正在回放技能，无法提炼');
  // 读轨迹与重连都是 await，名额要在第一个 await 之前占住，否则两次点击都能进来。
  distillation.claim(id);
  let session: {
    trajectory: Trajectory;
    prompt: string;
    name: string;
    live: Connection & { attachmentId: string };
    conversation: Conversation;
    finishLeaseActivity?: () => void;
  };
  try {
    const { trajectory, markdown } = await library.read(id);
    const name = trajectory.meta.name;
    // 第一期的老录制没有事件日志；读不到过程就按过程记录上线之前的老样子提炼。
    const events = await library.readEvents(id);
    const prompt = buildDistillPrompt(
      name,
      markdown,
      events?.length ? renderEvents(events) : undefined,
    );
    // 重炼时留在同一个提炼对话里；否则和「新对话」一样新建并重连出干净的 session。
    const reuse =
      workspace.current?.title === `提炼：${name}` &&
      workspace.current.agentId === current.config.id &&
      !workspace.current.task;
    if (!reuse) {
      connectionBusy = true;
      try {
        workspace.create(randomUUID(), current.config.id);
        workspace.current!.title = `提炼：${name}`;
        await connectAgent(current.config.id);
      } finally {
        connectionBusy = false;
      }
    }
    const finishLeaseActivity = attachmentLease?.beginActivity();
    const live = requireAttachment();
    const conversation = workspace.current!;
    distillation.begin(id, name, conversation.id);
    session = { trajectory, prompt, name, live, conversation, finishLeaseActivity };
  } catch (error) {
    // begin 之后不会再抛，所以这里退的就是还没开跑的那个占位。
    distillation.release();
    throw error;
  }
  const { trajectory, prompt, name, live, conversation, finishLeaseActivity } = session;
  promptActive = true;
  promptCancelled = false;
  taskId = randomUUID();
  lastError = undefined;
  workspace.append({
    id: randomUUID(),
    role: 'user',
    text: `提炼「${name}」`,
    time: new Date().toISOString(),
    status: 'completed',
  });
  agentStatus = 'running';
  emit();
  const start = conversation.messages.length;
  try {
    const result = await runPrompt([{ type: 'text', text: prompt }], {
      prompt: (contents) => live.transport.prompt(contents),
      messages: () => conversation.messages,
      cancelled: () => promptCancelled || connection !== live,
      onResult: (result) => log(`提炼回合结束：${result.stopReason}`),
      diagnostics: () => ({ agent: live.transport.capabilities.agentInfo }),
    });
    // 取消是返回值，不是异常：半截回合不能当成 Agent 交出来的成品。
    if (result.stopReason === 'cancelled' || promptCancelled || connection !== live)
      distillation.reject({ id, name, conversationId: conversation.id, reason: '已取消' });
    else {
      const reply = conversation.messages
        .slice(start)
        .filter((message) => message.role === 'assistant')
        .map((message) => message.text)
        .join('');
      distillation.accept({
        id,
        name,
        conversationId: conversation.id,
        reply,
        trajectory,
        distilledBy: live.config.id,
      });
    }
  } catch (error) {
    distillation.reject({
      id,
      name,
      conversationId: conversation.id,
      reason: promptCancelled ? '已取消' : readable(error),
    });
  } finally {
    distillation.release();
    finishLeaseActivity?.();
    promptActive = false;
    for (const message of conversation.messages)
      if (message.status === 'running') message.status = 'completed';
    if (connection === live) agentStatus = 'ready';
    emit();
  }
}

/** 界面只给结构化操作，但「不能新建动作步骤」在这里执行，不依赖界面。 */
async function saveSkillEdit(input: {
  id: string;
  prose: string;
  steps: Record<string, unknown>[];
}): Promise<void> {
  if (!(await library.hasSkill(input.id))) throw new Error('该技能尚未提炼，先提炼再编辑');
  const busy = distillation.busyReasonFor(input.id);
  if (busy) throw new Error(`${busy}，请先保留或丢弃提案`);
  const { skill } = await library.readSkill(input.id);
  const submitted = input.steps.map((raw, index) => {
    const parsed = StepSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`第 ${index + 1} 步不合法：${parsed.error.issues[0].message}`);
    return parsed.data;
  });
  const verdict = validateSkillEdit(skill.steps, submitted);
  if (!verdict.ok)
    throw new Error(
      verdict.reason === 'NEW_ACTION'
        ? `第 ${verdict.step} 步是新增的动作，编辑不能新建动作步骤`
        : `第 ${verdict.step} 步重复了现有动作，编辑不能复制动作步骤`,
    );
  await library.writeSkill(input.id, input.prose, { ...skill, steps: submitted });
  store.recordEvent('skill', input.id, 'skill.edited', { steps: submitted.length });
  await refreshSkills();
}
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

/**
 * 多会话运行时账本：按 conversationId 记录每个会话的 principal、agentTabId 与独立 lease。
 * 真正的 transport / MCP socket 仍随连接持有；这里只做并发上限、跨会话 ACL 判定与「停止/接管/
 * 沉默只作用本会话」的记账。interrupt 回调落到本会话自己的连接上，不波及兄弟会话。
 */
const sessionRuntimes = new SessionRuntimeRegistry(
  {
    interrupt: (conversationId, mode) => {
      // 单连接阶段：只有当前活跃会话会走到这里；多连接接入后这里按 conversationId 路由到对应 transport。
      if (conversationId === workspace.data.activeConversationId)
        void interruptAgent(mode, mode === 'manual' ? undefined : '会话已停止').catch(() => {});
    },
  },
  { userPrincipal: USER_PRINCIPAL },
);

/** Agent 在后台标签干活时的临时唤醒管理器：新开的标签默认留后台，需要渲染/输入时才挂出来。 */
const backgroundTabs = new BackgroundTabWakeManager({
  wake: (tabId) => {
    const item = pages.get(tabId);
    if (!item) return;
    // 挂上视图树让它真实渲染，并关掉后台节流，否则 CDP 拿到的坐标/像素会退化成占位。
    item.view.webContents.setBackgroundThrottling(false);
    layout();
  },
  hide: (tabId) => {
    const item = pages.get(tabId);
    if (!item) return;
    item.view.webContents.setBackgroundThrottling(true);
    layout();
  },
  // 这个后台标签上还挂着等人决策的浏览器审批，就先别把它摘回隐藏。
  keepWoken: (tabId) =>
    [...approvals.values()].some(
      (approval) => approval.kind === 'browser' && approval.tabId === tabId,
    ),
});

const configPath = () => join(app.getPath('userData'), 'agents.json');
const databasePath = () => join(app.getPath('userData'), 'host.sqlite');
const recordingsPath = () => join(app.getPath('userData'), 'recordings');
/** 本地预设缺适配器时，Pilion 把它装在这里，不碰全局 npm 和 npx 缓存。 */
const adaptersPath = () => join(app.getPath('userData'), 'adapters');
let adapterInstall: AdapterInstallState | undefined;
const state = (): AppState => ({
  tabs: [...pages.values()].map((item) => item.model),
  activeTabId,
  // Agent 不在了就不留标识：交回给人、任务结束、接管、断开都从这里一起消失。
  agentTabId: isAgentBrowserActive() ? agentTabId : undefined,
  // 多会话明细：每个会话各自的 Agent 标签与运行状态，侧栏据此同时标出多个 Agent 标签。
  // 徽标随各自会话的任务状态亮灭：任务结束/交回/断开后，该会话的标识一起消失。
  agentTabs: sessionRuntimes
    .list()
    .filter((runtime) => runtime.agentTabId)
    .map((runtime) => ({
      conversationId: runtime.conversationId,
      tabId: runtime.agentTabId!,
      running: runtime.status === 'running',
    }))
    .filter(
      (entry) =>
        workspace.data.conversations.find((conv) => conv.id === entry.conversationId)?.task
          ?.status === 'running',
    ),
  agents,
  agentStatus,
  adapterInstall,
  agentActivityPhase: isAgentBrowserActive() ? currentAgentActivityPhase() : undefined,
  attachmentStatus: connection?.attachmentId ? 'attached' : connection ? 'detached' : 'none',
  approvals: [...approvals.values()].map((item) => ({
    ...item.view,
    nonce: item.nonce,
    actionDigest: item.actionDigest,
    // 审批按挂起时记录的会话归属下发：面板按 activeConversationId 过滤，A 的审批不串到 B。
    conversationId: item.conversationId,
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
  agentImageCapable: Boolean(connection?.transport.capabilities.agent.promptCapabilities?.image),
  skillProposals: skillProposals.list().map((proposal) => ({
    proposalId: proposal.proposalId,
    conversationId: proposal.conversationId,
    messageId: proposal.messageId,
    name: proposal.name,
    stepCount: proposal.steps.length,
    preview: proposal.prose,
  })),
  permissionMode: workspace?.data.permissionMode ?? 'full',
  recording: recordingSession.snapshot(),
  skills,
  schedules: schedules?.items ? [...schedules.items] : undefined,
  replay: replay?.state,
  distillation: distillation.running
    ? { ...distillation.running, status: 'running' }
    : distillation.pending
      ? {
          id: distillation.pending.id,
          name: distillation.pending.name,
          conversationId: distillation.pending.conversationId,
          status: 'proposed',
          markdown: distillation.pending.markdown,
          steps: skillStepViews(distillation.pending.skill.steps, distillation.pending.manual),
        }
      : distillation.rejected
        ? { ...distillation.rejected, status: 'rejected' }
        : undefined,
  agentReplay: agentReplay
    ? { name: agentReplay.name, step: agentReplay.step, total: agentReplay.total }
    : undefined,
  settings: settings?.data,
  downloadLocation: downloadLocation(
    settings?.data.downloadDirectory ?? app.getPath('downloads'),
    app.getPath('home'),
  ),
  update: updates?.state ?? { currentVersion: app.getVersion(), status: { kind: 'unsupported' } },
  externalConnections: externalServer?.describeConnections() ?? [],
});
/** 更新状态不属于工作区，只广播，不安排写盘。 */
function broadcast(): void {
  syncAgentShield();
  if (window && !window.isDestroyed()) {
    const snapshot = state();
    window.webContents.send(IPC.state, snapshot);
    if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible())
      settingsWindow.webContents.send(IPC.state, snapshot);
    refreshMenu(snapshot);
  }
}
function emit(): void {
  broadcast();
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
function taskRunning(conversationId?: string): boolean {
  const conversation = conversationId
    ? workspace.data.conversations.find((item) => item.id === conversationId)
    : workspace?.current;
  return conversation?.task?.status === 'running';
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
  if (replayRunning()) return 'act';
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
      viewport.visible &&
        (tabId === activeTabId || backgroundTabs.isWoken(tabId)) &&
        item.model.url !== HOME &&
        !item.model.error,
    );
    if (!item.view.getVisible()) pageFactory.pointer.hideFor(item.view);
  }
  syncAgentShield();
}
function syncAgentShield(): void {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const active = isAgentBrowserActive() || replayRunning();
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
  if (tabId === activeTabId && !item.model.loading && item.model.url !== handoverBaseline) {
    if (handoverBaseline !== undefined) recordHandover(`打开了 ${item.model.url}`);
    handoverBaseline = item.model.url;
  }
  if (!item.model.loading)
    workspace.visit({
      url: item.model.url,
      title: item.model.title,
      time: new Date().toISOString(),
    });
  // 文档一开始换，上一份 observe 的序号就不再指向同一批元素。
  if (item.model.loading) recordingSession.dropObservation(tabId);
  else if (item.model.url !== HOME)
    recordingSession.pageLoaded(tabId, {
      url: item.model.url,
      title: item.model.title,
      text: '',
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
    if (agentShield?.locked) takeShellFocus();
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
    if (input.type !== 'keyDown') return;
    const action = interceptedShortcut(input);
    if (!action) return;
    event.preventDefault();
    // 人在网页里按下的快捷键，窗口本来就在前台，不受静默模式影响。
    window.webContents.focus();
    window.webContents.send('app:shortcut', action);
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
    if (recordingSession.tabId() === tabId) leaveRecordingTab(undefined);
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
  leaveRecordingTab(opened.tabId);
  if (replayRunning()) stopReplay();
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
async function openExternalUrl(url: string): Promise<void> {
  await openTab(url);
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
}
async function closeTab(tabId: string, principal = USER_PRINCIPAL): Promise<void> {
  if (recordingSession.tabId() === tabId) leaveRecordingTab(undefined);
  if (replayRunning() && tabId === activeTabId) stopReplay();
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
  // 标识指向的标签页没了就先空着：不把标识挪到一页 Agent 其实还没碰过的标签上。
  if (agentTabId === tabId) agentTabId = undefined;
  findResult = undefined;
  rememberTabs();
  layout();
  emit();
  if (!pages.size && !draining) await openTab();
}
function activateTab(tabId: string, principal = USER_PRINCIPAL): void {
  leaveRecordingTab(tabId);
  if (replayRunning() && tabId !== activeTabId) stopReplay();
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
async function reopenClosedTab(index = closedTabs.length - 1): Promise<string | undefined> {
  const [closed] = closedTabs.splice(index, 1);
  if (!closed) return undefined;
  try {
    return await openTab(closed.url);
  } catch (error) {
    closedTabs.splice(index, 0, closed);
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
  // 主窗口标签未必注册进 browser registry（只有经 BrowserService 打开的标签才有）；
  // 未注册说明该标签不在 Agent 的浏览器抽象下，没有 ACL 需要写，跳过即可。
  if (!browser.registry.has(tabId)) return;
  browser.setTabAcl(USER_PRINCIPAL, tabId, {
    entries: [
      { principalId: USER_PRINCIPAL, role: 'owner' },
      { principalId: connection.principal, role: 'operator' },
    ],
  });
}
function revokeAgentAcls(principal?: string): void {
  pageFactory.pointer.hide();
  // 连接一走，标识就没有主人了；重新附加时不该亮着一个上一轮的旧标签页。
  const target = principal ?? connection?.principal;
  if (!target) return;
  browser.invalidatePrincipal(target);
  // 多会话下只摘掉本会话 Agent 的 operator 权限，不重写整表（那会误删兄弟会话的 ACL）。
  browser.removePrincipalFromAcls(target);
  if (principal === undefined) agentTabId = undefined;
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
  const leaseExpiresAt = Date.now() + ATTACHMENT_IDLE_MS;
  store.createAttachment({
    attachmentId,
    sessionId: current.sessionId,
    principal: current.principal,
    agentId: current.config.id,
    role: 'owner',
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
    connectionEpoch: current.connectionEpoch,
    capabilitySnapshotHash: current.capabilitySnapshotHash,
  });
  current.attachmentId = attachmentId;
  current.attachmentLease?.stop();
  current.attachmentLease = new AttachmentLease({
    leaseExpiresAt,
    now: () => Date.now(),
    setTimer: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer),
    isActive: () =>
      current.attachmentId === attachmentId &&
      !current.promptCancelled &&
      (current.promptActive || taskRunning(current.conversationId) || current.toolExecutions > 0),
    renew: (deadline) =>
      current.attachmentId === attachmentId &&
      store.renewAttachment(attachmentId, new Date(deadline).toISOString()),
    expire: () => {
      if (current.attachmentId !== attachmentId) return;
      try {
        store.transitionAttachment(attachmentId, 'expired');
      } catch {
        /* already terminal */
      }
      expireCurrentAttachment();
    },
  });
  // 模块级 attachmentLease 是「活跃会话 lease」的投影：旧调用点（提炼、工具 beginActivity）
  // 仍读它，多会话下指向当前被选中会话的那份 lease。
  attachmentLease = current.attachmentLease;
  for (const tabId of pages.keys()) grantAgentTabAcl(tabId);
  log('Agent 已附加；Session / Attachment / Tab ACL 生效');
}
function detachAgent(target: Connection = connection as Connection): void {
  if (!target?.attachmentId) return;
  store.transitionAttachment(target.attachmentId, 'detached');
  target.attachmentLease?.stop();
  target.attachmentLease = undefined;
  target.attachmentId = undefined;
  if (target === connection) attachmentLease = undefined;
  revokeAgentAcls(target.principal);
  cancelBrowserApprovals();
  cancelAcpApprovals(target.transport.sessionId);
  log('Agent 已分离，Tab effect 权限已撤销');
}

async function connectAgent(id: string): Promise<void> {
  // 只断开「当前这个对话」已有的连接，不打断别的正在运行的会话。
  if (workspace.current) await disconnectAgent(workspace.current.id);
  const config = agents.find((item) => item.id === id && item.enabled);
  if (!config) throw new Error('Agent 配置不存在或已禁用');
  const resumableConversation =
    workspace.current?.agentId === config.id ? workspace.current : undefined;
  agentStatus = 'starting';
  lastError = undefined;
  emit();
  // MCP 桥在构造时拿到 execute；用一个可变委托，连接建立后绑定到本会话的 actor 身份，
  // 这样会话 B 的 Agent 发的工具调用不会落到会话 A 的 attachment 上。
  let boundExecute: (request: ToolRequest) => Promise<unknown> = (request) =>
    executeTool(request);
  const mcpHost = new BrowserMcpHost({
    directory: join(app.getPath('userData'), 'mcp'),
    bridgePath: join(__dirname, 'agents/browser-mcp-bridge.js'),
    execute: (request) => boundExecute(request),
  });
  try {
    const remoteSocket =
      config.transport === 'ssh' ? `/tmp/pilion-${randomUUID()}.sock` : undefined;
    const mcpServer = await mcpHost.start(remoteSocket);
    let installed: AdapterInstallState | undefined;
    const launch = remoteSocket
      ? sshLaunch(config, mcpHost.socketPath, remoteSocket)
      : await resolveLocalLaunch(config, {
          adaptersRoot: adaptersPath(),
          onInstall: (preset) =>
            log(
              `正在安装 ${preset.name} 的 ACP 适配器（${preset.package}），首次安装可能需要几分钟`,
            ),
          onInstallProgress: (progress) => {
            adapterInstall = progress;
            if (progress) installed = progress;
            broadcast();
          },
        });
    if (installed) {
      const seconds = Math.max(0, Math.floor((Date.now() - installed.startedAt) / 1000));
      const elapsed =
        seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
      log(`${installed.name} 的 ACP 适配器已安装，用时 ${elapsed}`);
    }
    const trusted = processManager.approve(launch);
    const transport = await processManager.connect(trusted, {
      limits: {
        handshakeTimeoutMs: config.preset ? 180_000 : 30_000,
        promptIdleTimeoutMs: PROMPT_IDLE_MS,
      },
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
    // principal 按会话去重：两个对话连同一个 Agent 配置时，TabRegistry.setAcl 要求 principal 唯一，
    // 否则会撞车、ACL 互相覆盖。agentId 仍是配置本身，principal 多挂一段会话指纹即可。
    const conversationSlug = workspace.current
      ? sha256(workspace.current.id).slice(0, 8)
      : 'shared';
    const principal = `agent:${config.id}:${conversationSlug}`;
    const capabilitySnapshotHash = sha256(transport.capabilities);
    store.createSession({
      sessionId,
      profileId: PROFILE_ID,
      principal,
      agentId: config.id,
      connectionEpoch: 1,
      capabilitySnapshotHash,
    });
    const conn: Connection = {
      conversationId: workspace.current!.id,
      config,
      transport,
      mcpHost,
      principal,
      sessionId,
      capabilitySnapshotHash,
      connectionEpoch: 1,
      promptActive: false,
      promptCancelled: false,
      connectionBusy: false,
      toolExecutions: 0,
    };
    // 多会话：新连接登记到会话表，不打断其它正在跑的会话；transport 事件经 WeakMap 路由回本会话。
    sessions.set(conn.conversationId, conn);
    transportSessions.set(transport, conn);
    connection = conn;
    transport.on('sessionUpdate', (update) => {
      const target = transportSessions.get(transport);
      if (target) handleSessionUpdate(target, update);
    });
    transport.on('goal', (goal) => {
      const target = transportSessions.get(transport);
      if (target) handleGoalUpdate(target, goal);
    });
    transport.on('trace', (trace) => {
      const target = transportSessions.get(transport);
      if (
        target &&
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
      const target = transportSessions.get(transport);
      if (target) void failConnection(target, transportError);
    });
    transport.on('idle', ({ silentMs }) => {
      const target = transportSessions.get(transport);
      if (target) handleAgentSilence(target, silentMs);
    });
    transport.on('state', (value) => {
      const target = transportSessions.get(transport);
      if (!target || value.current !== 'closed') return;
      sessions.delete(target.conversationId);
      if (connection === target) {
        connection = undefined;
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
    // 绑定本会话的 actor：每次调用按 conn 实时字段重建——接管/分离后 attachmentId 会变，
    // 不能在连接建立那一刻把旧快照钉死，否则恢复后工具调用拿着失效身份。
    boundExecute = (request) =>
      executeTool(request, {
        principal: conn.principal,
        sessionId: conn.sessionId,
        attachmentId: conn.attachmentId ?? '',
        connectionEpoch: conn.connectionEpoch,
        capabilitySnapshotHash: conn.capabilitySnapshotHash,
      });
    // 在多会话账本里登记这个对话：记录它的 principal、并发名额与独立 lease。
    sessionRuntimes.begin(workspace.current!.id, principal, config.id);
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
async function failConnection(conn: Connection, failure: unknown): Promise<void> {
  sessions.delete(conn.conversationId);
  lastError = `Agent 协议失败：${readable(failure)}`;
  if (connection === conn) agentStatus = 'error';
  const attachmentId = conn.attachmentId;
  conn.attachmentLease?.stop();
  conn.attachmentLease = undefined;
  conn.attachmentId = undefined;
  revokeAgentAcls(conn.principal);
  if (attachmentId) {
    try {
      store.transitionAttachment(attachmentId, 'failed');
    } catch {
      /* already terminal */
    }
  }
  try {
    store.transitionSession(conn.sessionId, 'failed');
  } catch {
    /* already terminal */
  }
  cancelBrowserApprovals();
  cancelAcpApprovals(conn.transport.sessionId);
  if (connection === conn) connection = undefined;
  emit();
  await conn.transport.stop();
  await conn.mcpHost.stop();
}
function expireCurrentAttachment(): void {
  if (!connection?.attachmentId) return;
  connection.attachmentLease?.stop();
  connection.attachmentLease = undefined;
  connection.attachmentId = undefined;
  revokeAgentAcls(connection.principal);
  lastError = 'Attachment lease 已过期，Agent Tab ACL 已撤销';
  cancelBrowserApprovals();
  cancelAcpApprovals(connection.transport.sessionId);
  emit();
}
async function disconnectAgent(conversationId?: string): Promise<void> {
  const current = conversationId ? sessions.get(conversationId) : connection;
  if (!current) return;
  sessions.delete(current.conversationId);
  if (connection === current) {
    agentStatus = 'stopping';
    emit();
  }
  if (current.attachmentId) detachAgent(current);
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
  if (connection === current) {
    connection = undefined;
    agentStatus = 'disconnected';
  }
  emit();
}

function handleSessionUpdate(conn: Connection, notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate === 'config_option_update' ||
    update.sessionUpdate === 'current_mode_update'
  ) {
    emit();
    return;
  }
  const conversation = conversationById(conn.conversationId);
  if (conn.promptCancelled || !conversation) return;
  const updateRunning = conn.promptActive || conversation.task?.status === 'running';
  if (
    (update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk') &&
    update.content.type === 'text'
  ) {
    const role = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought';
    let message = conversation.messages.find((item) => item.id === conn.activeResponseId);
    if (!message || message.role !== role) {
      message = {
        id: randomUUID(),
        role,
        text: '',
        time: new Date().toISOString(),
        status: updateRunning ? 'running' : 'completed',
      };
      conversation.messages.push(message);
      conversation.updatedAt = message.time;
      conn.activeResponseId = message.id;
    }
    message.text += update.content.text;
    emit();
    return;
  }
  if (update.sessionUpdate === 'tool_call') {
    conn.activeResponseId = undefined;
    const id = `${conn.taskId ?? 'session'}:${update.toolCallId}`;
    const existing = conversation.messages.find((item) => item.id === id);
    const status =
      update.status === 'completed' || update.status === 'failed' ? update.status : 'running';
    if (existing) {
      existing.text = update.title;
      if (status !== 'running' || existing.status === 'running') existing.status = status;
    } else
      conversation.messages.push({
        id,
        role: 'tool',
        text: update.title,
        time: new Date().toISOString(),
        status,
      });
    conversation.updatedAt = new Date().toISOString();
  }
  if (update.sessionUpdate === 'tool_call_update') {
    const tool = conversation.messages.find(
      (item) => item.id === `${conn.taskId ?? 'session'}:${update.toolCallId}`,
    );
    if (tool) {
      if (update.title) tool.text = update.title;
      if (update.status === 'completed' || update.status === 'failed') tool.status = update.status;
    }
  }
  if (update.sessionUpdate === 'plan') {
    const planId = `${conn.taskId ?? 'session'}:plan`;
    let plan = conversation.messages.find((item) => item.id === planId);
    if (!plan) {
      plan = { id: planId, role: 'tool', text: '', time: new Date().toISOString() };
      conversation.messages.push(plan);
    }
    plan.text = update.entries
      .map((entry) => `${entry.status === 'completed' ? '[x]' : '[ ]'} ${entry.content}`)
      .join('\n');
  }
  emit();
}

function handleGoalUpdate(conn: Connection, goal: AgentGoalSnapshot | null): void {
  const conversation = conversationById(conn.conversationId);
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
    if (connection === conn) agentStatus = 'running';
    emit();
    return;
  }
  if (goal && ['paused', 'blocked', 'limited'].includes(goal.status)) {
    pauseForHuman(conn, goal.lastReason);
    return;
  }
  conn.attachmentLease?.activity();
  task.status = 'completed';
  for (const message of conversation.messages)
    if (message.status === 'running') message.status = 'completed';
  conn.activeResponseId = undefined;
  if (!conn.promptActive && connection === conn) agentStatus = 'ready';
  emit();
}

/**
 * The Agent stops and the person takes the browser, with the task kept so it can be resumed.
 * A goal-capable Agent reaches this through its goal status; every other Agent reaches it by
 * calling browser.request_human, which is the only inbound channel plain ACP leaves open.
 */
function pauseForHuman(conn: Connection, reason?: string | null): void {
  const conversation = conversationById(conn.conversationId);
  const task = conversation?.task;
  if (!conversation || !task) return;
  task.status = 'manual';
  task.updatedAt = new Date().toISOString();
  task.handover = [];
  for (const message of conversation.messages)
    if (message.status === 'running') message.status = 'cancelled';
  if (connection === conn) agentStatus = 'ready';
  conn.activeResponseId = undefined;
  const text = reason?.trim();
  if (text)
    conversation.messages.push({
      id: randomUUID(),
      role: 'system',
      text,
      time: new Date().toISOString(),
      status: 'failed',
    });
  handoverBaseline = currentPageUrl();
  requestAttention();
  emit();
}

function currentPageUrl(): string | undefined {
  return pages.get(activeTabId ?? '')?.model.url;
}

let handoverBaseline: string | undefined;

/** Records what the person did while they held the browser, so the Agent is told on resume. */
function recordHandover(entry: string): void {
  const task = workspace.current?.task;
  if (!task || task.status !== 'manual') return;
  task.handover = [...(task.handover ?? []), entry].slice(-50);
}

function autoRecordingName(): string {
  return `录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
}

/** 录制跟着它开始时的标签走：焦点一离开那个标签，就停止并保存，不让它挂在后台继续计数。 */
function leaveRecordingTab(nextTabId: string | undefined): void {
  const tabId = recordingSession.tabId();
  if (!tabId || tabId === nextTabId) return;
  void recordingSession
    .leaveTab(nextTabId, autoRecordingName())
    .then(refreshSkills)
    .catch((error) => {
      lastError = `录制保存失败：${readable(error)}`;
      emit();
    });
}

/** 别的东西正在开浏览器时不让开录制；返回的就是拒绝的理由。会话层只认这一个出口。 */
function recordingBusyReason(): string | undefined {
  if (replayRunning()) return '正在回放技能，无法同时录制';
  if (agentReplayStarting || agentReplay) return 'Agent 正在回放技能';
  if (distillation.active) return '正在提炼，请稍后';
  if (isAgentBrowserActive() || promptActive || taskRunning())
    return 'Agent 正在执行任务，先停止或接管后再录制';
  return undefined;
}

async function refreshSkills(): Promise<void> {
  skills = await library.list();
  emit();
}

/** 只有人能开录制：入口只有可信 Renderer 的 IPC，MCP 里没有这个动词。 */
async function startRecording(): Promise<void> {
  const tabId = requireActiveTab();
  await recordingSession.start(tabId);
  // 已经停在一个真实页面上就先记一条 page；之后只有换页的 sync() 才会再记。
  const model = pages.get(tabId)?.model;
  if (model && model.url !== HOME && !model.loading)
    recordingSession.pageLoaded(tabId, { url: model.url, title: model.title, text: '' });
}

/** 停止并保存，再把技能库重新读一遍：刚存下的那条要立刻出现在列表里。 */
async function stopRecording(name: string): Promise<string | undefined> {
  const id = await recordingSession.stop(name);
  await refreshSkills();
  return id;
}

function skillStepViews(
  steps: ReadonlyArray<Step>,
  manual: ReadonlyArray<number> = [],
): SkillStepView[] {
  return steps.map((step, index) => ({
    index: index + 1,
    kind: step.kind,
    text: describeStep(step),
    ...(manual.includes(index + 1) ? { manual: true } : {}),
    raw: step as unknown as Record<string, unknown>,
  }));
}

/** 点开详情就算人看过重算提示：确认掉它；确认到了东西就说明列表还挂着这份的短标记，刷新一次让它跟上。 */
async function skillDetail(id: string): Promise<SkillDetail> {
  const { trajectory, markdown } = await library.read(id);
  const recomputed = library.acknowledgeRecompute(id);
  if (recomputed) await refreshSkills();
  if (await library.hasSkill(id)) {
    const { prose, skill, markdown: skillMarkdown } = await library.readSkill(id);
    return {
      id,
      name: skill.meta.name,
      recordedAt: skill.meta.recordedAt,
      markdown,
      distilled: true,
      about: skill.meta.about,
      prose,
      skillMarkdown,
      steps: skillStepViews(skill.steps, unsupportedSteps(skill, trajectory)),
      ...(recomputed ? { recomputed: true } : {}),
    };
  }
  let index = 0;
  return {
    id,
    name: trajectory.meta.name,
    recordedAt: trajectory.meta.recordedAt,
    markdown,
    distilled: false,
    steps: trajectory.entries.flatMap((entry) =>
      entry.kind === 'step'
        ? [
            {
              index: (index += 1),
              kind: entry.step.kind,
              text: describeStep(entry.step),
              ...(entry.unsupported ? { unsupported: entry.unsupported } : {}),
              ...(entry.ambiguous ? { ambiguous: true } : {}),
              raw: entry.step as unknown as Record<string, unknown>,
            },
          ]
        : [],
    ),
    ...(recomputed ? { recomputed: true } : {}),
  };
}

async function executeTool(request: ToolRequest, actor?: Actor): Promise<unknown> {
  // 录制锁改为标签级：只拒绝「目标是录制标签」的工具调用，其它标签上的会话照常运行。
  // tabs.open / tabs.list 没有目标标签，不受录制影响（人在录一页时可以让 Agent 在别页干活）。
  const recordingTab = recordingSession.isRecording() ? recordingSession.tabId() : undefined;
  if (recordingTab && targetTab(request) === recordingTab)
    throw new Error('正在录制这个标签，浏览器工具暂不可用');
  if (!actor && distillation.running) throw new Error('提炼期间不提供浏览器工具，请只输出文档');
  // 回放也在驾驶同一个标签：没带身份的调用都是 Agent 从 MCP 来的，和录制一样挡住。
  if (!actor && replayRunning()) throw new Error('正在回放技能，浏览器工具暂不可用');
  if (!actor && promptCancelled) throw new Error('任务已停止，浏览器操作已取消');
  if (!actor && toolExecutions === 0 && agentStatus === 'ready') {
    restoreReadyAfterTools = true;
    agentStatus = 'running';
  }
  toolExecutions += 1;
  // The Agent waits on Pilion for as long as this call takes, an approval included. That is not the
  // Agent going silent.
  const releaseSilenceClock = connection?.transport.holdIdle();
  let finishLeaseActivity: (() => void) | undefined;
  emit();
  let toolConn: Connection | undefined;
  try {
    const current = actor ?? requireAttachment();
    toolConn = actor
      ? [...sessions.values()].find((item) => item.sessionId === actor.sessionId)
      : connection;
    if (toolConn) toolConn.toolExecutions += 1;
    if (current.attachmentId === connection?.attachmentId) {
      finishLeaseActivity = attachmentLease?.beginActivity();
      requireAttachment();
    }
    return await runTool(request, current);
  } finally {
    finishLeaseActivity?.();
    releaseSilenceClock?.();
    if (toolConn) toolConn.toolExecutions = Math.max(0, toolConn.toolExecutions - 1);
    toolExecutions = Math.max(0, toolExecutions - 1);
    if (toolExecutions === 0 && restoreReadyAfterTools) {
      restoreReadyAfterTools = false;
      if (agentStatus === 'running' && !taskRunning()) agentStatus = 'ready';
    }
    emit();
  }
}
/** 回放前把技能读出来：只有 Agent 能调，只准播已提炼的，同任务内同哈希只审一次。 */
async function loadSkillForPlay(
  request: ToolRequest,
  actor: Actor,
): Promise<{ skill: Skill; fromStep: number; hash: string; approved: boolean }> {
  if (actor.principal === USER_PRINCIPAL) throw new Error('人工回放请使用技能库的播放');
  if (agentReplayStarting || agentReplay) throw new Error('已有技能在回放');
  // MCP 不串行化工具调用：名额要在第一个 await 之前占住，否则两通并发调用都能过闸，
  // 后一通会顶掉前一通的 abort，前一个播放器就再也停不下来了。
  agentReplayStarting = true;
  try {
    const args = SkillsPlayArgsSchema.parse(request.args);
    if (!(await library.hasSkill(args.skillId)))
      throw new Error('该技能未提炼，Agent 只能回放已提炼的技能');
    const { skill } = await library.readSkill(args.skillId);
    const fromStep = args.fromStep ?? 1;
    if (fromStep > skill.steps.length) throw new Error('起始步骤超出范围');
    const hash = stepsHash(skill.steps);
    const taskKey = workspace.current?.task?.id ?? 'no-task';
    return { skill, fromStep, hash, approved: approvedSkills.get(taskKey)?.has(hash) ?? false };
  } catch (error) {
    agentReplayStarting = false;
    throw error;
  }
}
async function runTool(request: ToolRequest, actor: Actor): Promise<unknown> {
  const isExternal = actor.principal.startsWith('external:');
  const who =
    actor.principal === USER_PRINCIPAL ? '回放' : isExternal ? '外部调用' : 'Agent';
  log(`${who} 正在执行：${request.name}`);
  const current = actor;
  if (request.name === 'browser.request_human') {
    if (actor.principal === USER_PRINCIPAL) throw new Error('人工回放不能调用 request_human');
    const reason = String((request.args as { reason?: unknown }).reason ?? '').slice(0, 500);
    const conn = [...sessions.values()].find((item) => item.sessionId === actor.sessionId);
    if (conn) pauseForHuman(conn, reason);
    log(`Agent 请求人工介入：${reason}`);
    return { handedOver: true, message: '浏览器已交回给用户，请结束本回合并等待其继续任务。' };
  }
  if (request.name.startsWith('browser.schedule.')) {
    // (a) 定时任务自己启动的对话一律禁止再创建/改定时任务——防止自繁殖。
    if (workspace.current?.origin === 'scheduled')
      throw new Error('由定时任务启动的对话不能再调用 browser.schedule.*');
    return await runScheduleTool(request);
  }
  const skillPlay =
    request.name === 'browser.skills.play' ? await loadSkillForPlay(request, actor) : undefined;
  // 外部调用必须显式点名标签：在 targetTab（会回退到 activeTabId）之前就判断，
  // 绝不 fallback 到用户正在看的标签，也不在 ACL 校验前 snapshot 用户当前页。
  if (
    isExternal &&
    request.name !== 'browser.tabs.open' &&
    request.name !== 'browser.tabs.list' &&
    typeof request.args.tabId !== 'string'
  ) {
    throw new Error('外部调用必须显式指定 tabId（先 `browser.tabs.list` 拿到自己标签的 id）');
  }
  try {
    const tabId = targetTab(request);
    // 人自己按的播放走的是同一条执行通道，标识只认 Agent 的那一份；外部调用不占会话位、
    // 不点亮侧栏标识，也不写任何会话的 agentTabId。
    if (current.principal !== USER_PRINCIPAL && !isExternal && tabId) {
      if (tabId !== agentTabId) {
        agentTabId = tabId;
        const conversationId = workspace.data.activeConversationId;
        if (conversationId) sessionRuntimes.setAgentTab(conversationId, tabId);
        emit();
      }
      // 后台标签需要渲染/输入的操作：临时唤醒它（挂视图树、关节流），并续 30 秒回落计时。
      if (backgroundTabs.isBackground(tabId)) backgroundTabs.touch(tabId);
    }
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
    const verdict: PolicyVerdict = skillPlay
      ? skillPlay.approved
        ? {
            verdict: 'allow',
            policySetVersion: POLICY_VERSION,
            reasonCodes: ['PAGE_STATE_CHANGE'],
            obligations: [],
          }
        : {
            // 一份技能是一捆预授权副作用：full 模式也问，同任务内同哈希只问一次。
            verdict: 'require_approval',
            policySetVersion: POLICY_VERSION,
            reasonCodes: ['PAGE_STATE_CHANGE'],
            obligations: [{ type: 'trusted_approval', parameters: {} }],
          }
      : // 人工回放是人自己按的播放，不再问人；Agent 回放技能的每一步已由那次审批覆盖。
        workspace.data.permissionMode === 'full' ||
          actor.principal === USER_PRINCIPAL ||
          actor.replayApproval
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
    // canonical 只认可序列化值：哈希并进参数后再算 commandHash / digest，两者都盖住它。
    if (skillPlay) command.arguments = { ...command.arguments, stepsHash: skillPlay.hash };
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
          conversationId:
            [...sessions.values()].find((item) => item.sessionId === actor.sessionId)
              ?.conversationId ?? connection?.conversationId ?? '',
          summary: skillPlay
            ? skillApprovalSummary(skillPlay.skill)
            : `${isExternal ? `来源：外部调用（${actor.principal}）\n` : ''}${trustedApprovalSummary(command, trustedElement, effect)}`,
        })
      ).approvalDigest;
    if (skillPlay) {
      if (approvalId) {
        const taskKey = workspace.current?.task?.id ?? 'no-task';
        const set = approvedSkills.get(taskKey) ?? new Set<string>();
        set.add(skillPlay.hash);
        approvedSkills.set(taskKey, set);
      }
      pendingSkillPlays.set(request.requestId, {
        skill: skillPlay.skill,
        fromStep: skillPlay.fromStep,
        approvalId,
        actor,
      });
    }
    return await executePreparedAction({
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
  } catch (error) {
    // 审批被拒、审批过期、准备失败：技能还没开播就夭折了，名额与待办都要还回去。
    if (skillPlay) {
      agentReplayStarting = false;
      pendingSkillPlays.delete(request.requestId);
    }
    throw error;
  }
}

async function executePreparedAction(input: {
  request: ToolRequest;
  current: Actor;
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
        result: executionFailureResult(error),
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
    case 'browser.skills.list':
      return (await library.list())
        .filter((row) => row.distilled && !row.error)
        .map(({ id, name, about, steps, needsHuman, recordedAt }) => ({
          id,
          name,
          about: about ?? '',
          steps,
          needsHuman,
          recordedAt,
        }));
    case 'browser.skills.play': {
      const play = pendingSkillPlays.get(request.requestId);
      pendingSkillPlays.delete(request.requestId);
      if (!play) throw new Error('技能回放没有经过裁决');
      return playSkillForAgent(request.args.skillId as string, play, play.actor);
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
  leaveRecordingTab(opened.tabId);
  // 这里只有工具调用能到；回放期间唯一在发工具调用的就是回放自己，所以不在这里停回放。
  // Agent 新开的标签默认留在后台，不抢用户当前选中的标签；等它真要在上面渲染/输入时再临时唤醒。
  backgroundTabs.register(opened.tabId);
  // 新开的标签页就是 Agent 接下来操作的那一个；人自己按的播放不算。
  if (principal !== USER_PRINCIPAL) {
    agentTabId = opened.tabId;
    const conversationId = workspace.data.activeConversationId;
    if (conversationId) sessionRuntimes.setAgentTab(conversationId, opened.tabId);
  }
  layout();
  emit();
  return opened.tabId;
}

function targetTab(request: ToolRequest): string | undefined {
  if (request.name === 'browser.tabs.open' || request.name === 'browser.tabs.list')
    return undefined;
  if (typeof request.args.tabId === 'string') return request.args.tabId;
  // 后台标签模式：Agent 省略 tabId 时，优先落它自己会话正在操作的那个标签，而不是用户此刻
  // 正在看的页面。只有这个会话还没碰过任何标签时，才退回用户的活动标签（单标签附加的老行为）。
  const conversationId = workspace.data.activeConversationId;
  const runtimeTab = conversationId ? sessionRuntimes.agentTab(conversationId) : undefined;
  return runtimeTab ?? activeTabId;
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
  if (request.name === 'browser.skills.play')
    base.skill = {
      skillId: requireString(request.args.skillId, 'skillId'),
      fromStep: typeof request.args.fromStep === 'number' ? request.args.fromStep : 1,
    };
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
/** 技能的审批把每一步都摊开：人看到的是这一捆副作用的全文，不是一个工具名。 */
function skillApprovalSummary(skill: Skill): string {
  return [
    `回放技能「${skill.meta.name}」`,
    // about 是 Agent 写的，摊平成一行，免得它用换行伪造出几条编号步骤。
    skill.meta.about.replace(/\s+/g, ' ').trim(),
    '',
    ...skill.steps.map((step, index) => `${index + 1}. ${describeStep(step)}`),
  ].join('\n');
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
  // 禁用状态由页面适配器在执行时检查，观察中的状态只用于展示。
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
  conversationId: string;
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
      conversationId: input.conversationId,
      timer,
      resolve,
      reject,
    };
    approvals.set(input.approvalId, pending);
    requestAttention();
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
      (targetUrl && approvalOrigin(targetUrl) !== pending.origin);
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
/** 审批绑定用的 origin：空白页在 canonical command 里就是字面量 'about:blank'，两侧必须一致。 */
function approvalOrigin(url: string | undefined): string {
  return !url || url === HOME ? HOME : safeOrigin(url) || HOME;
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
  if (pending.kind === 'schedule') {
    pending.view.state = response.decision === 'approve' ? 'approved' : 'denied';
    clearTimeout(pending.timer);
    approvals.delete(response.approvalId);
    emit();
    pending.resolve(response.decision === 'approve');
    return;
  }
  const tab = browser.registry.has(pending.tabId) ? browser.registry.get(pending.tabId) : undefined;
  const currentOrigin = approvalOrigin(pages.get(pending.tabId)?.view.webContents.getURL());
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
      conversationId:
        [...sessions.values()].find((item) => item.sessionId === request.sessionId)
          ?.conversationId ?? '',
      timer,
      allowOptionId,
      rejectOptionId,
      resolve: resolvePermission,
    };
    approvals.set(approvalId, pending);
    requestAttention();
    emit();
  });
}

/**
 * browser.schedule.create 的用户审批：与页面权限无关，无论 permissionMode 都要问人。
 * 摘要里带 prompt 全文、规则和接下来三次触发时间；拒绝/超时一律按未批准处理。
 */
function requestScheduleApproval(summary: string): Promise<boolean> {
  const approvalId = randomUUID();
  const nonce = randomBytes(24).toString('base64url');
  const actionDigest = sha256({ approvalId, summary });
  return new Promise((resolveApproval) => {
    const view: ApprovalViewState = {
      approvalId,
      tool: '创建定时任务',
      summary,
      state: 'pending',
      statusText: '该请求来自 Agent。创建后它会按规则在后台自动运行。',
    };
    const timer = setTimeout(() => {
      if (!approvals.delete(approvalId)) return;
      view.state = 'expired';
      emit();
      resolveApproval(false);
    }, 60_005);
    const pending: PendingScheduleApproval = {
      kind: 'schedule',
      view,
      nonce,
      actionDigest,
      timer,
      resolve: resolveApproval,
    };
    approvals.set(approvalId, pending);
    requestAttention();
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

/**
 * 只认主窗口自己的主 frame。设置窗口跑的是同一份渲染层，只在 handle() 显式放行的通道上被认；
 * 包括 update:check 与 update:install：重启确认仍由主进程判断。
 * 审批这类必须由主窗口里的人亲手点的通道永远不放行它。
 */
function trustedRenderer(event: IpcMainInvokeEvent, allowPreferences = false): void {
  const senderFrame = event.senderFrame;
  const preferences =
    allowPreferences &&
    Boolean(settingsWindow) &&
    !settingsWindow!.isDestroyed() &&
    event.sender === settingsWindow!.webContents;
  const owner = preferences ? settingsWindow : window;
  if (
    !owner ||
    !senderFrame ||
    event.sender !== owner.webContents ||
    senderFrame !== owner.webContents.mainFrame
  )
    throw new Error('拒绝非可信 Renderer IPC sender/frame');
  const expected = rendererUrl(preferences);
  if (
    process.env.VITE_DEV_SERVER_URL
      ? new URL(senderFrame.url).origin !== new URL(expected).origin
      : senderFrame.url !== expected
  )
    throw new Error('拒绝非可信 Renderer origin');
}
function rendererUrl(preferences = false): string {
  const url = new URL(
    process.env.VITE_DEV_SERVER_URL ??
      pathToFileURL(join(app.getAppPath(), 'dist-renderer/index.html')).href,
  );
  if (preferences) url.searchParams.set('window', 'preferences');
  return url.href;
}
async function loadRenderer(target: BrowserWindow, preferences = false): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) await target.loadURL(rendererUrl(preferences));
  else
    await target.loadFile(
      join(app.getAppPath(), 'dist-renderer/index.html'),
      preferences ? { query: { window: 'preferences' } } : undefined,
    );
}
const CHROME_ROOT = 'Library/Application Support/Google/Chrome';

function chromeCookieRoot(): string {
  return join(app.getPath('home'), CHROME_ROOT);
}

async function chromeCookieSources(): Promise<ChromeCookieSources> {
  if (process.platform !== 'darwin')
    return { supported: false, reason: '目前只支持 macOS 上的 Chrome', profiles: [] };
  const profiles = await chromeProfiles(chromeCookieRoot());
  return profiles.length
    ? { supported: true, profiles }
    : { supported: false, reason: '未找到本机 Chrome 的配置文件', profiles: [] };
}

async function importChromeCookies(chromeProfile: string): Promise<ChromeCookieImportResult> {
  const sources = await chromeCookieSources();
  if (!sources.supported) throw new Error(sources.reason ?? '无法读取本机 Chrome');
  const profile = sources.profiles.find((item) => item.id === chromeProfile);
  if (!profile) throw new Error('未找到该 Chrome 配置文件');
  const secret = await chromeSafeStorageSecret(
    (command, args) =>
      new Promise<string>((resolve, reject) => {
        execFile(command, [...args], { timeout: 30_000 }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
      }),
  );
  const { cookies, unreadable } = await readChromeCookies({
    profileDirectory: join(chromeCookieRoot(), profile.id),
    key: chromeCookieKey(secret),
    scratchDirectory: join(app.getPath('userData'), 'chrome-import'),
  });
  const target = session.fromPartition('persist:pilion-default');
  let rejected = 0;
  for (const cookie of cookies) {
    try {
      await target.cookies.set(cookie);
    } catch {
      rejected += 1;
    }
  }
  // Chromium accepts an already expired cookie and then drops it, and it normalises domains on
  // the way in, so the store itself is the only number that matches what a site will see.
  const stored = await target.cookies.get({});
  const domains = new Set(stored.map((cookie) => cookie.domain));
  log(
    `Chrome「${profile.name}」导入后，工作区有 ${stored.length} 条 cookie，覆盖 ${domains.size} 个域名`,
  );
  return {
    profile: profile.name,
    stored: stored.length,
    unreadable,
    rejected,
    domains: domains.size,
  };
}

function handle<T>(
  channel: string,
  schema: { parse(value: unknown): T } | undefined,
  fn: (value: T, event: IpcMainInvokeEvent) => unknown,
  options: { preferences?: boolean } = {},
): void {
  ipcMain.handle(channel, (event, value) => {
    // preferences 只放行设置窗口的主 frame；更新检查与安装也必须经过这道校验。
    trustedRenderer(event, options.preferences);
    return fn(schema ? schema.parse(value) : (value as T), event);
  });
}
function authorizeBrowserPrincipal(principalId: string): void {
  if (principalId === USER_PRINCIPAL) return;
  // 外部 principal 走自己的 attachment，不挂在全局 agent 连接上。
  if (principalId.startsWith('external:')) {
    const live = [...externalAttachments.values()].find((entry) => entry.principal === principalId);
    if (!live) throw new HostError('INVALID_STATE_TRANSITION', '外部连接已断开');
    store.assertAttachmentAccess({
      sessionId: live.sessionId,
      attachmentId: live.attachmentId,
      principal: live.principal,
      connectionEpoch: live.connectionEpoch,
    });
    return;
  }
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
  let directory = settings.data.downloadDirectory ?? app.getPath('downloads');
  if (settings.data.downloadDirectory) {
    try {
      assertDownloadDirectory(directory);
    } catch {
      directory = app.getPath('downloads');
      log(`下载「${basename(filename)}」：设置的下载位置不可用，已退回系统下载目录`);
    }
  }
  const safeName = basename(filename.replaceAll('\\', '/')) || 'download';
  const extension = extname(safeName);
  const stem = basename(safeName, extension);
  const reserved = new Set(workspace.data.downloads.map((item) => item.savePath));
  for (let index = 0; ; index += 1) {
    const suffix = index ? ` (${index})` : '';
    const candidate = join(directory, `${stem}${suffix}${extension}`);
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
function requireDownloadRecord(id: string): DownloadRecord {
  const record = workspace.data.downloads.find((item) => item.id === id);
  if (!record) throw new Error('下载记录不存在');
  return record;
}
function requireDownload(id: string): DownloadRecord {
  const record = requireDownloadRecord(id);
  if (!isDownloadPathAllowed(record, app.getPath('downloads'), settings.data.downloadDirectory))
    throw new Error('文件不在当前下载位置');
  return record;
}

async function chooseDownloadDirectory(parent: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(parent, {
    title: '选择下载位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  const directory = result.filePaths[0];
  assertDownloadDirectory(directory);
  await settings.setDownloadDirectory(directory);
  broadcast();
}

async function resetDownloadDirectory(): Promise<void> {
  await settings.setDownloadDirectory(undefined);
  broadcast();
}

function clearHistory(): void {
  workspace.data.history = [];
  emit();
}

function clearDownloadRecords(): void {
  workspace.data.downloads = workspace.data.downloads.filter(
    (item) => item.status === 'progressing' || item.status === 'paused',
  );
  emit();
}

async function clearBrowsingData(
  value: BrowsingDataClearInput,
  parent: BrowserWindow,
): Promise<BrowsingDataClearResult> {
  const categories = [
    value.history && '浏览记录',
    value.downloads && '下载记录（只清除列表，不删除文件）',
    value.cookies && 'Cookie 和网站数据',
    value.cache && '缓存的图片和文件',
  ].filter(Boolean);
  const warning = value.cookies ? '\n\n这会退出大多数网站，包括 Agent 正在使用的登录状态。' : '';
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    message: '清除所选浏览数据？',
    detail: `将清除全部时间范围内的：\n${categories.join('\n')}${warning}`,
    buttons: ['清除', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return { cleared: false };
  if (value.cookies || value.cache) {
    const target = session.fromPartition('persist:pilion-default');
    if (value.cookies) await target.clearStorageData();
    if (value.cache) await target.clearCache();
  }
  if (value.history) clearHistory();
  if (value.downloads) clearDownloadRecords();
  return { cleared: true };
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
  library = new RecordingLibrary(recordingsPath());
  // 崩溃在临时文件写完与 rename 之间留下的孤儿，启动时清一次；没有单实例锁，两个
  // 实例可能同时各写各的 .tmp，清扫只动早于阈值的，失败不该拖着启动一起失败。
  await library
    .sweepStaleTempFiles()
    .catch((error) => console.error('清扫录制临时文件失败', error));
  skills = await library.list().catch(() => []);
  workspace = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'));
  try {
    await workspace.load();
  } catch (error) {
    lastError = `无法读取已有工作区：${readable(error)}`;
  }
  if (!workspace.current) workspace.create(randomUUID());
  settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  await settings.load();
  store.reconcileExecuting({});
  schedules = new SchedulesStore(join(app.getPath('userData'), 'schedules.json'));
  await schedules.load();
  scheduler = new SchedulerEngine({
    store: schedules,
    runner: scheduledRunner,
    recordEvent: (eventType, id, payload) => store.recordEvent('schedule', id, eventType, payload),
    notify: (title, body) => {
      try {
        if (!Notification.isSupported()) return;
        new Notification({ title, body }).show();
      } catch {
        /* 不支持桌面通知时静默降级 */
      }
    },
    tickMs: process.env.PILION_SCHEDULE_TICK_MS ? Number(process.env.PILION_SCHEDULE_TICK_MS) : undefined,
  });
  scheduler.start();
  powerMonitor.on('resume', () => scheduler?.onResume());
  powerMonitor.on('unlock-screen', () => scheduler?.onResume());
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
  // 静默模式下窗口不在前台时，Agent 的指针不画出来：它是个独立的小窗口，会浮在别的应用上面。
  pageFactory = new ElectronPageFactory(
    window,
    () => undefined,
    validateUrl,
    () => settings.data.agentWindowBehavior !== 'silent' || window.isFocused(),
  );
  browser = new BrowserService({
    pageFactory,
    grantVerifier: verifier(),
    resolver,
    authorizePrincipal: authorizeBrowserPrincipal,
  });
  window.on('resize', layout);
  // 「关闭窗口时退出」关掉时，关窗只是把它藏起来，Agent 连接与任务都留着；点 Dock 图标再拿回来。
  // 只在 macOS 上这样做：别的平台没有 Dock 可点，藏起来的窗口就再也找不回来了。
  window.on('close', (event) => {
    if (quitting || settings.data.quitOnWindowClose || process.platform !== 'darwin') return;
    event.preventDefault();
    // 全屏时直接 hide 会留下一个黑色的全屏空间：先退出全屏，退出完再藏。
    if (window.isFullScreen()) {
      window.once('leave-full-screen', () => window.hide());
      window.setFullScreen(false);
    } else window.hide();
  });
  window.on('closed', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  });
  // 静默模式下 Agent 开工时没有抢焦点；人切回来的这一刻补上，键盘输入不会落进护罩下面的网页。
  window.on('focus', () => {
    if (agentShield?.locked) window.webContents.focus();
  });
  await configureSecurity(resolver);
  registerIpc();
  app.setAboutPanelOptions({
    applicationName: 'Pilion',
    applicationVersion: app.getVersion(),
    copyright: '© echoVic',
  });
  refreshMenu(state());
  await loadRenderer(window);
  agentShield = new AgentShield(window, takeShellFocus);
  const restore = settings.data.startupBehavior === 'restore' ? [...workspace.data.tabs] : [];
  const index = restore.length ? workspace.data.activeTabIndex : 0;
  for (const url of restore.length ? restore.slice(0, 30) : [HOME]) await openTab(url);
  const restored = [...pages.keys()][index];
  if (restored) activateTab(restored);
  await externalUrls.flush();
  if (settings.data.externalControl) startExternalControl();
  void startUpdates().catch((error) => console.error('自动更新启动失败', error));
}
/** 只有打包后的应用检查更新；开发模式和 e2e（包括用 PILION_E2E_EXECUTABLE 跑打包版）都不联网。 */
async function startUpdates(): Promise<void> {
  if (!app.isPackaged || process.env.NODE_ENV === 'test') return;
  const { autoUpdater } = (await import('electron-updater')).default;
  updates = new UpdateController({
    updater: autoUpdater,
    nativeUpdater: process.platform === 'darwin' ? nativeAutoUpdater : undefined,
    currentVersion: app.getVersion(),
    // deb 的安装要管理员密码，后台装不了：只提示，让人去 Release 页面下载。
    manualOnly: process.platform === 'linux' && !process.env.APPIMAGE,
    releaseUrl: (version) => `https://github.com/echoVic/pilion-browser/releases/tag/v${version}`,
    openExternal: (url) => void shell.openExternal(url),
    onChange: () => broadcast(),
  });
  updates.setAutoUpdate(settings.data.autoUpdate);
  broadcast();
}
/**
 * 「立即重启」：Agent 在干活、有审批在等、正在录制、回放或下载时先确认；确认后先走正常的退出收尾
 * （shutdown），再交给 electron-updater 安装并重新打开。
 */
async function installUpdate(parent: BrowserWindow | undefined): Promise<void> {
  await updates?.restart({
    interrupts: () =>
      restartInterrupts({
        agentStatus,
        pendingApprovals: approvals.size,
        recording: recordingSession.isRecording(),
        replaying: replayRunning() || Boolean(agentReplay),
        distilling: Boolean(distillation.running),
        activeDownloads: activeDownloads.size,
      }),
    confirm: async () => {
      const options = {
        type: 'warning' as const,
        buttons: ['立即重启', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '现在重启会中断正在进行的工作',
        detail: 'Agent 的任务、等待审批的操作、录制、技能回放或正在进行的下载都会停止。',
      };
      const { response } = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      return response === 0;
    },
    drain: async () => {
      quitting = true;
      installingUpdate = true;
      await shutdown();
      // 万一更新程序没把 Pilion 退出（比如 Squirrel.Mac 出错），30 秒后自己退；已经暂存好的更新退出时照样安装。
      setTimeout(() => app.quit(), 30_000);
    },
  });
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

async function executeAgentTask(
  input: { text: string; attachments?: PromptAttachment[] },
  resuming = false,
) {
  const text = input.text;
  const attachments = input.attachments ?? [];
  if (recordingSession.isRecording()) throw new Error('正在录制，请先停止录制再发送任务');
  if (replayRunning()) throw new Error('正在回放技能，请先停止回放');
  const current = requireAttachment();
  // 只认本会话是否已在跑任务：A 在后台跑时，切到 B 发任务不能被 A 的 promptActive 投影挡住。
  if (current.promptActive || connectionBusy || agentStatus !== 'ready')
    throw new Error('请等待当前任务结束');
  // 图片能力以 Agent 在 initialize 公布的 promptCapabilities.image 为准。不支持时直接拒绝，
  // 而不是把图发出去被静默丢弃——渲染层也会据此禁用附件 UI。
  if (attachments.length && !current.transport.capabilities.agent.promptCapabilities?.image)
    throw new Error('当前 Agent 不支持图片输入，请改为文字描述');
  if (workspace.current?.agentId !== current.config.id)
    workspace.create(randomUUID(), current.config.id);
  const conversation = workspace.current!;
  if (resuming && conversation.task?.status !== 'manual') throw new Error('该任务不能继续');
  const finishLeaseActivity = attachmentLease?.beginActivity();
  requireAttachment();
  const handover = resuming ? (conversation.task?.handover ?? []) : [];
  const cursor = resuming ? conversation.task?.replayCursor : undefined;
  conversation.task = resuming
    ? {
        ...conversation.task!,
        status: 'running',
        agentGoalStatus: undefined,
        lastReason: undefined,
        handover: undefined,
        replayCursor: undefined,
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
  // 同步到本会话连接：lease/沉默检测按 conn 自己的字段判断，模块级仍是活跃会话的投影。
  current.promptActive = true;
  current.promptCancelled = false;
  // 新一回合从「还没碰过哪个标签页」开始，第一次工具调用落到哪一页就标哪一页。
  agentTabId = undefined;
  current.activeResponseId = undefined;
  current.taskId = taskId;
  taskId = randomUUID();
  lastError = undefined;
  const turnStartIndex = conversation.messages.length;
  const userMessageId = randomUUID();
  workspace.append({
    id: userMessageId,
    role: 'user',
    text: text || '继续任务',
    time: new Date().toISOString(),
    status: 'completed',
    // 只留元数据，不存 base64：图片本体随 ACP 这回合发给 Agent 后不再需要，避免工作区膨胀。
    ...(attachments.length
      ? {
          attachments: attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: Buffer.byteLength(attachment.data, 'base64'),
          })),
        }
      : {}),
  });
  agentStatus = 'running';
  emit();
  // The page moved while the person held it, so the Agent is told rather than left to guess.
  const cursorNote = cursor
    ? `技能「${cursor.name}」停在第 ${cursor.nextStep - 1} 步交还给了我，请用 browser_skills_play 从 fromStep = ${cursor.nextStep} 续播。`
    : '';
  const handoverNote = handover.length ? `我刚才接管了浏览器，期间：${handover.join('；')}。` : '';
  const resumeText = [handoverNote, cursorNote, text].filter(Boolean).join('\n') || '继续任务';
  let status: ConversationMessage['status'] = 'completed';
  try {
    if (current.transport.supportsPersistentGoals) {
      runningTask.executionMode = 'goal';
      status = 'running';
      await current.transport.setGoal(runningTask.goal);
      // Goal 回合是长任务指令，图片附件只在普通 prompt 回合带上，不塞进 goal 续接。
      if (resuming && (handoverNote || cursorNote || text))
        await current.transport.prompt([{ type: 'text', text: resumeText }]);
      return { stopReason: 'end_turn' };
    }
    runningTask.executionMode = 'prompt';
    const promptText = resuming ? resumeText : text;
    const result = await runPrompt(promptContents(promptText, attachments), {
      prompt: (contents) => current.transport.prompt(contents),
      messages: () => conversation.messages,
      // 只认本会话的取消标记：切到别的会话不能把后台正在跑的本回合误判为取消。
      cancelled: () => current.promptCancelled,
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
    finishLeaseActivity?.();
    promptActive = false;
    current.promptActive = false;
    pageFactory.pointer.hide();
    // 普通聊天回合里 Agent 若顺手吐了 ```json pilion-skill 块，收作「待人确认的提案」。
    // 不落盘、不新建技能——只让人在界面上把它指给某份已提炼技能当修改（见 proposals.ts）。
    for (const message of conversation.messages.slice(turnStartIndex)) {
      if (message.role !== 'assistant') continue;
      skillProposals.capture({
        conversationId: conversation.id,
        messageId: message.id,
        reply: message.text,
      });
    }
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

/**
 * 定时任务在多会话并行模型下的运行器：到点时在后台新建一条 `origin:'scheduled'` 对话，
 * 用它绑定的 Agent 开一条独立连接跑 prompt，不切换用户当前对话、不断开用户的连接。
 * 只有当活跃会话数撞上并发上限（4）时才记 `skipped: capacity`；用户是否在跑任务、
 * 是否在录制/回放都不影响——录制是标签级锁，定时任务在自己新开的后台标签上操作。
 * 实现上临时把 activeConversationId 指向 scheduled 对话（这样 connectAgent / executeAgentTask
 * 会绑定到它自己的 connection），跑完立即还原用户原来选中的对话。
 */
const scheduledRunner: ScheduledPromptRunner = {
  async run({ conversationTitle, agentId, prompt, scheduleId }) {
    if (sessionRuntimes.runningCount() >= MAX_CONCURRENT_SESSIONS)
      return { status: 'skipped', reason: 'capacity' };
    const config = agents.find((item) => item.id === agentId && item.enabled);
    if (!config) return { status: 'skipped', reason: 'no_agent' };
    const userSelectedId = workspace.data.activeConversationId;
    const conversationId = randomUUID();
    scheduledRunId = scheduleId;
    try {
      workspace.data.conversations.unshift({
        id: conversationId,
        title: conversationTitle,
        agentId,
        updatedAt: new Date().toISOString(),
        messages: [],
        origin: 'scheduled',
      });
      // 临时把焦点指向 scheduled 对话：connectAgent 只为这个对话建一条新连接并登记进
      // sessions[conversationId]，用户正在跑的连接互不影响（多会话并行）。
      workspace.data.activeConversationId = conversationId;
      await connectAgent(agentId);
      await executeAgentTask({ text: prompt });
      return { status: 'ok', conversationId };
    } catch (error) {
      return { status: 'failed', conversationId, reason: readable(error) };
    } finally {
      scheduledRunId = undefined;
      if (!draining) workspace.data.activeConversationId = userSelectedId;
      emit();
    }
  },
  isRunning(id) {
    return scheduledRunId === id;
  },
};

/** 人从设置页或 Agent 经审批后创建一条定时任务；绑定的 Agent 必须已配置。 */
function createSchedule(input: ScheduleInput, origin: ScheduleOrigin): ScheduledPrompt {
  const config = agents.find((item) => item.id === input.agentId);
  if (!config) throw new Error('绑定的 Agent 不存在');
  if (!schedules) throw new Error('定时任务存储未就绪');
  let created: ScheduledPrompt;
  try {
    created = schedules.create(input, origin, new Date());
  } catch (error) {
    if (error instanceof ScheduleLimitError) throw new Error(error.message, { cause: error });
    throw error;
  }
  store.recordEvent('schedule', created.id, 'schedule.created', {
    agentId: created.agentId,
    origin: origin.kind,
  });
  emit();
  return created;
}

function formatWhenShort(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** browser.schedule.* 的 MCP 实现：create/delete 一律走用户审批，list 只读。 */
async function runScheduleTool(request: ToolRequest): Promise<unknown> {  if (request.name === 'browser.schedule.list') {
    return {
      schedules: (schedules?.items ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        rule: item.rule,
        enabled: item.enabled,
        nextRunAt: item.nextRunAt,
      })),
    };
  }
  if (request.name === 'browser.schedule.delete') {
    const { id } = IdInputSchema.parse(request.args);
    const item = schedules?.get(id);
    if (!item) throw new Error('定时任务不存在');
    const approved = await requestScheduleApproval(
      ['来源：Agent 提供的工具输入（未经 Pilion 验证）', `操作：删除定时任务「${item.name}」`].join('\n'),
    );
    if (!approved) throw new Error('用户拒绝了删除定时任务');
    schedules?.remove(id);
    store.recordEvent('schedule', id, 'schedule.deleted', { via: 'mcp' });
    emit();
    return { deleted: id };
  }
  // browser.schedule.create：无论 permissionMode 都要用户审批（含 full 模式）。
  const input = ScheduleInputSchema.parse(request.args);
  const preview = previewRuns(input.rule, new Date(), 3)
    .map((at) => formatWhenShort(at))
    .join('、');
  const summary = [
    '来源：Agent 提供的工具输入（未经 Pilion 验证）',
    `操作：创建定时任务「${input.name}」`,
    `绑定 Agent：${input.agentId}`,
    `规则：${describeRule(input.rule)}`,
    `接下来三次：${preview}`,
    'Prompt 全文：',
    input.prompt,
  ].join('\n');
  const approved = await requestScheduleApproval(summary);
  if (!approved) throw new Error('用户拒绝了创建定时任务');
  const created = createSchedule(input, {
    kind: 'agent',
    conversationId: workspace.current?.id ?? 'unknown',
  });
  return { id: created.id, nextRunAt: created.nextRunAt };
}

/**
 * The Agent has said nothing for a long time and nothing is waiting on Pilion. Ask it to stop the way
 * the take-over button does: the turn ends cleanly, the process and ACP session survive, and the task
 * can be resumed. Only an Agent that ignores the request loses its connection (interruptAgent's
 * watchdog).
 */
function handleAgentSilence(conn: Connection, silentMs: number): void {
  if (!conn.promptActive || conn.promptCancelled) return;
  const conversation = conversationById(conn.conversationId);
  if (!conversation) return;
  const quiet =
    silentMs >= 60_000
      ? `${Math.round(silentMs / 60_000)} 分钟`
      : `${Math.max(1, Math.round(silentMs / 1000))} 秒`;
  const resumable = conversation.task?.status === 'running';
  const notice = `Agent 已连续 ${quiet}没有任何动静，已请它停止${resumable ? '。点「继续任务」可以让它接着做' : ''}。`;
  conversation.messages.push({
    id: randomUUID(),
    role: 'system',
    text: notice,
    time: new Date().toISOString(),
    status: 'failed',
  });
  requestAttention();
  void interruptAgent(resumable ? 'manual' : 'stopped', notice, conn.conversationId).catch(
    (error) => {
      if (connection === conn) lastError = readable(error);
      emit();
    },
  );
}

async function interruptAgent(mode: 'manual' | 'stopped', note?: string, conversationId?: string) {
  const conversation = conversationId
    ? conversationById(conversationId)
    : workspace.current;
  const task = conversation?.task;
  if (task && (task.status === 'running' || task.status === 'manual')) {
    task.status = mode;
    task.updatedAt = new Date().toISOString();
  } else if (mode === 'manual') throw new Error('当前没有可接管的任务');
  // 断开的连接会让下面两处提前 return：播放器的唯一取消口在那之前就得按下。
  agentReplay?.abort.abort();
  emit();
  const current = connection;
  if (!current || current.transport.state !== 'ready') return;
  if (promptCancelled && !current.attachmentId) return;
  promptCancelled = true;
  current.promptCancelled = true;
  if (promptActive) agentStatus = 'stopping';
  for (const message of workspace.current?.messages ?? [])
    if (message.status === 'running') message.status = 'cancelled';
  if (current.attachmentId) detachAgent();
  else browser.invalidatePrincipal(current.principal);
  pageFactory.pointer.hide();
  cancelAcpApprovals(current.transport.sessionId);
  cancelBrowserApprovals();
  log(note ?? (mode === 'manual' ? '你正在操作浏览器，任务等待继续' : '任务已停止'));
  const cancelledTask = taskId;
  const deadline = setTimeout(() => {
    if (promptActive && taskId === cancelledTask && connection === current)
      void failConnection(current, new Error('Agent 未响应取消，连接已关闭'));
  }, 5_000);
  deadline.unref();
  const results = await Promise.allSettled([
    current.transport.cancel(),
    current.transport.clearGoal(),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') await failConnection(current, failure.reason);
}

/**
 * 菜单只在它显示的东西变了时才重建：emit() 很频繁，每次都 setApplicationMenu 会让展开着的菜单被收起。
 */
function refreshMenu(snapshot: AppState): void {
  const next: MenuState = {
    closedTabs: closedTabs.map(({ title, url }) => ({ title, url })),
    agentConnected: Boolean(snapshot.connectedAgentId),
    attached: snapshot.attachmentStatus === 'attached',
    agentDriving: snapshot.agentStatus === 'running' && snapshot.attachmentStatus === 'attached',
    manualTask: workspace?.current?.task?.status === 'manual',
    agentBusy: ['starting', 'stopping', 'running'].includes(snapshot.agentStatus),
    recording: Boolean(snapshot.recording),
    // 与界面上的按钮同一条件：Agent 正在操作或技能在回放时，导航与缩放都不可用。
    navigationLocked: navigationLocked(snapshot),
    canRecord:
      Boolean(snapshot.recording) ||
      (!navigationLocked(snapshot) && (pages.get(activeTabId ?? '')?.model.url ?? HOME) !== HOME),
  };
  const signature = JSON.stringify(next);
  if (signature === menuSignature) return;
  menuSignature = signature;
  Menu.setApplicationMenu(
    buildMenu(next, {
      run: runMenuAction,
      openSettings,
      checkForUpdates: () => {
        openSettings({ pane: 'general' });
        void updates?.checkNow();
      },
      reopenClosedTab: (index, origin) => {
        void reopenClosedTab(index)
          .then(() => runMenuAction('showBrowser', origin))
          .catch((error) => {
            lastError = readable(error);
            emit();
          });
      },
    }),
  );
}
/**
 * 菜单动作交给主窗口的渲染层执行，与快捷键、界面按钮走同一段代码。设置窗口在前时 ⌘W 关的是设置窗口；
 * 其余动作作用在浏览器窗口上，所以先把它带到前面。
 */
function runMenuAction(action: AppAction, origin: BaseWindow | undefined): void {
  if (action === 'closeTab' && origin && origin !== window) {
    origin.close();
    return;
  }
  if (!window || window.isDestroyed()) return;
  if (origin !== window) window.show();
  // 与网页里按下的快捷键一样，先把键盘焦点交给 Pilion 自己的界面，地址栏和查找框才接得到输入。
  window.webContents.focus();
  window.webContents.send('app:command', action);
}
function navigationLocked(snapshot: AppState): boolean {
  return (
    (snapshot.agentStatus === 'running' && snapshot.attachmentStatus === 'attached') ||
    snapshot.replay?.status === 'running'
  );
}
/**
 * 打开设置窗口并告诉它停在哪。新建的窗口要等页面加载完才收得到；preload 会把这一次记下，
 * 渲染层晚一步挂上监听也不会错过。
 */
function openSettings(target: PreferencesTarget = {}): void {
  preferencesTarget = target;
  returnAfterConnect = Boolean(target.returnOnConnect);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // 藏着的这段时间没收到状态。先补一份最新的，再让它按目标重新打开，表单才不会拿旧状态初始化。
    settingsWindow.webContents.send(IPC.state, state());
    settingsWindow.webContents.send('preferences:open', target);
    settingsWindow.show();
    return;
  }
  const opened = createSettingsWindow({
    preload: join(__dirname, '../preload/entry.cjs'),
    dark:
      settings.data.theme === 'dark' ||
      (settings.data.theme !== 'light' && nativeTheme.shouldUseDarkColors),
    load: (created) => loadRenderer(created, true),
    quitting: () => quitting,
  });
  opened.webContents.once('did-finish-load', () =>
    opened.webContents.send('preferences:open', preferencesTarget),
  );
  // 藏起来期间不推状态，重新显示时补一份最新的。
  opened.on('show', () => opened.webContents.send(IPC.state, state()));
  opened.on('closed', () => {
    if (settingsWindow === opened) settingsWindow = undefined;
  });
  settingsWindow = opened;
}
/**
 * 把键盘焦点从网页移回 Pilion 自己的界面。macOS 上 webContents.focus() 会顺带激活应用、把窗口提到
 * 最前，所以静默模式下窗口不在前台时不动它；人切回来时窗口的 focus 事件会补上这一步。
 */
function takeShellFocus(): void {
  if (!window || window.isDestroyed()) return;
  if (settings.data.agentWindowBehavior === 'silent' && !window.isFocused()) return;
  window.webContents.focus();
}
/** 需要人确认或接管时，窗口不在前台就提醒一下。只提醒不抢焦点，两种窗口行为都适用。 */
function requestAttention(): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else {
    window.flashFrame(true);
    window.once('focus', () => window.flashFrame(false));
  }
}

function registerIpc(): void {
  // 只在显式声明的设置通道上放行设置窗口。
  const preferences = { preferences: true };
  handle(
    IPC.defaultBrowserGet,
    undefined,
    () => getDefaultBrowserStatus(app, process.platform, process.env.NODE_ENV),
    preferences,
  );
  handle(
    IPC.defaultBrowserSet,
    undefined,
    () => setDefaultBrowser(app, process.platform, process.env.NODE_ENV),
    preferences,
  );
  handle(IPC.getState, undefined, () => state(), preferences);
  handle(IPC.settingsGet, undefined, () => settings.data, preferences);
  handle(
    IPC.settingsSave,
    AppSettingsPatchSchema,
    async (patch) => {
      const saved = await settings.update(patch);
      if (patch.autoUpdate !== undefined) updates?.setAutoUpdate(saved.autoUpdate);
      if (patch.externalControl !== undefined) {
        if (saved.externalControl) startExternalControl();
        else await stopExternalControl().catch(() => undefined);
      }
      emit();
      return saved;
    },
    preferences,
  );
  handle(IPC.settingsOpen, PreferencesTargetSchema, (target) => openSettings(target));
  handle(
    IPC.externalDisconnect,
    IdInputSchema,
    (value) => {
      externalServer?.disconnectPrincipal(value.id);
      emit();
    },
    preferences,
  );
  // 含 token 的 MCP 配置只发给设置窗口，不进 state 广播，主窗口 renderer 拿不到。
  handle(IPC.externalMcpConfig, undefined, () => externalServer?.mcpConfig(), preferences);
  handle(
    IPC.downloadChooseDirectory,
    undefined,
    (_value, event) => chooseDownloadDirectory(BrowserWindow.fromWebContents(event.sender)!),
    preferences,
  );
  handle(IPC.downloadResetDirectory, undefined, () => resetDownloadDirectory(), preferences);
  handle(
    IPC.browsingDataClear,
    BrowsingDataClearSchema,
    (value, event) => clearBrowsingData(value, BrowserWindow.fromWebContents(event.sender)!),
    preferences,
  );
  // 设置页的「更新」分区也有这两个按钮；要不要先确认由主进程判断，与从哪个窗口点进来无关。
  handle(IPC.updateCheck, undefined, () => void updates?.checkNow(), preferences);
  handle(
    IPC.updateInstall,
    undefined,
    (_value, event) => installUpdate(BrowserWindow.fromWebContents(event.sender) ?? undefined),
    preferences,
  );
  handle(IPC.chromeCookieSources, undefined, () => chromeCookieSources());
  handle(IPC.chromeCookieImport, ChromeCookieImportSchema, async (value) => {
    try {
      return await importChromeCookies(value.chromeProfile);
    } catch (error) {
      lastError = `Chrome cookie 导入失败：${readable(error)}`;
      emit();
      throw error;
    }
  });
  handle(
    'agents:inspect-local',
    LocalInspectSchema,
    async (value) => ({
      ...(await inspectLocalAgents({ ...value, adaptersRoot: adaptersPath() })),
      defaultCwd: join(app.getPath('userData'), 'workspace-files'),
    }),
    preferences,
  );
  handle(
    'agents:configure-local',
    LocalAgentInputSchema,
    async (value) => {
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
    },
    preferences,
  );
  handle(
    'agents:choose-directory',
    undefined,
    async (_value, event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender) ?? window,
        { title: '选择 Agent 工作目录', properties: ['openDirectory', 'createDirectory'] },
      );
      return result.canceled ? undefined : result.filePaths[0];
    },
    preferences,
  );
  handle(IPC.viewport, ViewportSchema, (value) => {
    viewport = value;
    layout();
  });
  handle(IPC.tabOpen, UrlInputSchema, (value) => openTab(value.url));
  handle(IPC.tabActivate, IdInputSchema, (value) => activateTab(value.id));
  handle(IPC.tabClose, IdInputSchema, (value) => closeTab(value.id));
  handle(IPC.tabNavigate, NavigateInputSchema, async (value) => {
    const tabId = requireActiveTab();
    const result = await browser.navigate({ principalId: USER_PRINCIPAL, tabId, url: value.url });
    recordingSession.navigate(tabId, result.url);
    return result;
  });
  // 前进后退刷新的落地地址要等文档提交才知道，所以先算出预期落地的地址，把原因连同它
  // 一起挂起，由下一条 page 按落地地址是否对得上来判定这次导航是否真的发生、真的落在
  // 预期的地方（见 session.ts 的 pageLoaded）。没有历史可走、或者算不出预期地址时都不
  // 挂原因：没人消费的原因会一直悬到下一次真正换页，既可能张冠李戴出一条导航，又可能把
  // 那次 mousedown 即跳转的补点击吞掉。快捷键不像按钮那样有禁用态。
  handle(IPC.tabBack, undefined, () => {
    const tabId = requireActiveTab();
    const history = pages.get(tabId)!.view.webContents.navigationHistory;
    if (!history.canGoBack()) return;
    const expectedUrl = history.getEntryAtIndex(history.getActiveIndex() - 1)?.url;
    if (expectedUrl) recordingSession.pendingCause(tabId, 'back', expectedUrl);
    return history.goBack();
  });
  handle(IPC.tabForward, undefined, () => {
    const tabId = requireActiveTab();
    const history = pages.get(tabId)!.view.webContents.navigationHistory;
    if (!history.canGoForward()) return;
    const expectedUrl = history.getEntryAtIndex(history.getActiveIndex() + 1)?.url;
    if (expectedUrl) recordingSession.pendingCause(tabId, 'forward', expectedUrl);
    return history.goForward();
  });
  handle(IPC.tabReload, undefined, () => {
    const tabId = requireActiveTab();
    const webContents = pages.get(tabId)!.view.webContents;
    // 刷新落地的地址就是刷新前的地址；落地那条 page 本来会被会话层的去重吃掉，
    // 所以去重对「挂着原因、真的加载过」的那一条让路（见 session.ts 的 pageLoaded）。
    const expectedUrl = webContents.getURL();
    if (expectedUrl) recordingSession.pendingCause(tabId, 'reload', expectedUrl);
    return webContents.reload();
  });
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
    const record = requireDownloadRecord(value.id);
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
  handle(IPC.downloadClear, undefined, clearDownloadRecords);
  handle(
    IPC.agentSave,
    AgentConfigInputSchema,
    async (config) => {
      agents = [...agents.filter((item) => item.id !== config.id), config];
      await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 });
      emit();
    },
    preferences,
  );
  handle(
    IPC.agentRemove,
    IdInputSchema,
    async (value) => {
      if (connection?.config.id === value.id) throw new Error('请先断开此 Agent');
      agents = agents.filter((item) => item.id !== value.id);
      await writeFile(configPath(), JSON.stringify(agents, null, 2), { mode: 0o600 });
      emit();
    },
    preferences,
  );
  handle(
    IPC.agentConnect,
    IdInputSchema,
    async (value, event) => {
      if (connectionBusy || promptActive || taskRunning()) throw new Error('请等待当前任务结束');
      connectionBusy = true;
      try {
        await connectAgent(value.id);
      } finally {
        connectionBusy = false;
      }
      if (returnAfterConnect && event.sender === settingsWindow?.webContents) {
        returnAfterConnect = false;
        // 安装并连接可能要几分钟；人已经去了别的应用，就只收起设置窗口，不把 Pilion 拉到前面。
        const watching = settingsWindow.isFocused();
        settingsWindow.hide();
        if (watching) window.show();
      }
    },
    preferences,
  );
  handle(
    IPC.agentDisconnect,
    undefined,
    async () => {
      if (connectionBusy) throw new Error('连接正在变更');
      connectionBusy = true;
      try {
        await disconnectAgent();
      } finally {
        connectionBusy = false;
      }
    },
    preferences,
  );
  handle(IPC.agentAttach, undefined, () => attachAgent());
  handle(IPC.agentDetach, undefined, () => detachAgent());
  handle(IPC.agentTask, TaskInputSchema, ({ text, attachments }) =>
    executeAgentTask({ text, attachments }),
  );
  handle(IPC.agentCancel, undefined, () => interruptAgent('stopped'));
  handle(IPC.agentTakeOver, undefined, () => interruptAgent('manual'));
  handle(IPC.agentResume, ResumeTaskInputSchema, async ({ text }) => {
    if (recordingSession.isRecording()) throw new Error('正在录制，请先停止录制再发送任务');
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
    return executeAgentTask({ text }, true);
  });
  handle(IPC.conversationNew, undefined, async () => {
    // 多会话：新建对话不再因别的会话在跑而拒绝；连同一个 Agent 时在新对话里另起一条连接。
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
    if (!workspace.data.conversations.some((item) => item.id === value.id))
      throw new Error('对话不存在');
    if (value.id === workspace.data.activeConversationId) return;
    connectionBusy = true;
    try {
      // 纯 UI 焦点切换：不断开任何连接。后台会话继续跑，把投影切到被选中的那条连接。
      workspace.data.activeConversationId = value.id;
      connection = sessions.get(value.id);
      attachmentLease = connection?.attachmentLease;
      if (connection) agentStatus = connection.promptActive ? 'running' : 'ready';
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
  handle(IPC.historyClear, undefined, clearHistory);
  handle('workspace:copy-message', IdInputSchema, async (value) => {
    const message = workspace.current?.messages.find((item) => item.id === value.id);
    if (!message) throw new Error('消息不存在');
    clipboard.writeText(message.text);
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
  // 录制与技能库（只有可信 Renderer 能开录制；MCP 没有这个动词）
  handle(IPC.recordingStart, undefined, () => startRecording());
  handle(IPC.recordingStop, RecordingStopSchema, (value) => stopRecording(value.name));
  handle(IPC.recordingNote, RecordingNoteSchema, (value) => recordingSession.note(value.text));
  handle(IPC.skillsRead, IdInputSchema, (value) => skillDetail(value.id));
  handle(IPC.skillsPlay, SkillPlaySchema, (value) => startReplay(value.id, value.fromStep));
  handle(IPC.skillsResume, undefined, () => resumeReplay());
  handle(IPC.skillsStop, undefined, () => stopReplay());
  handle(IPC.skillsDistill, IdInputSchema, (value) => startDistillation(value.id));
  handle(IPC.skillsKeep, undefined, () => distillation.keep());
  handle(IPC.skillsDiscard, undefined, () => distillation.discard());
  handle(IPC.skillsSave, SkillSaveSchema, (value) => saveSkillEdit(value));
  // Agent 在普通聊天里提出的技能修改：人选定目标技能并确认后才写，写之前仍过编辑分权校验。
  handle(IPC.skillsProposalApply, SkillProposalApplySchema, (value) =>
    skillProposals.apply(value.proposalId, value.targetSkillId),
  );
  handle(IPC.skillsProposalDiscard, SkillProposalDiscardSchema, (value) =>
    skillProposals.discard(value.proposalId),
  );
  handle(IPC.skillsRemove, IdInputSchema, async (value) => {
    if (replay?.id === value.id && replayRunning()) throw new Error('正在回放，无法删除');
    const busy = distillation.busyReasonFor(value.id);
    if (busy) throw new Error(`${busy}，无法删除`);
    await library.remove(value.id);
    await refreshSkills();
  });
  handle(IPC.skillsRename, SkillRenameSchema, async (value) => {
    // 改名会重写 skill.md，提案还在手上时那份文件随时会被保留覆盖掉。
    const busy = distillation.busyReasonFor(value.id);
    if (busy) throw new Error(`${busy}，请先保留或丢弃提案`);
    await library.rename(value.id, value.name);
    await refreshSkills();
  });
  handle(IPC.skillsShow, IdInputSchema, (value) => shell.showItemInFolder(library.path(value.id)));
  // 过程视图专用：渲染在主进程做完，渲染层只拿到成行的文本，两万条事件不过桥。
  // capped 与 clamped 是两件不同的事：前者是录制当时就到了事件条数上限，后面根本没记下；
  // 后者是记下的过程比这里能展示的 300 行更长，渲染时砍掉了中间——两者互不蕴含。
  handle(IPC.recordingsEvents, SkillEventsArgsSchema, async (value) => {
    // 日志缺失或读不出都不该悄悄显示成空列表：requireEvents 直接报错，渲染层已经会把
    // 错误原因显示出来（第三期 Task 9 的修复），不用在这里把「没有」和「读不出」都
    // 吞成同一份空结果。
    const events = await library.requireEvents(value.id);
    const lines = renderEvents(events).split('\n').filter(Boolean);
    return {
      lines,
      capped: events.length >= MAX_EVENTS,
      clamped: lines.length > RENDER_EVENTS_LIMIT,
    };
  });
  // 定时任务：设置页「定时任务」分区专用，走设置窗口放行。
  const scheduleAccess = { preferences: true };
  handle(IPC.scheduleList, undefined, () => schedules?.items ?? [], scheduleAccess);
  handle(
    IPC.schedulePreview,
    SchedulePreviewSchema,
    ({ rule }) => previewRuns(rule, new Date(), 3).map((at) => at.toISOString()),
    scheduleAccess,
  );
  handle(
    IPC.scheduleSave,
    ScheduleInputSchema,
    (input) => createSchedule(input, { kind: 'user' }),
    scheduleAccess,
  );
  handle(
    IPC.scheduleDelete,
    IdInputSchema,
    (value) => {
      if (!schedules?.remove(value.id)) throw new Error('定时任务不存在');
      emit();
    },
    scheduleAccess,
  );
  handle(
    IPC.scheduleSetEnabled,
    ScheduleSetEnabledSchema,
    (value) => {
      if (!schedules?.setEnabled(value.id, value.enabled)) throw new Error('定时任务不存在');
      emit();
    },
    scheduleAccess,
  );
  handle(IPC.scheduleRunNow, IdInputSchema, async (value) => {
    const item = schedules?.get(value.id);
    if (!item) throw new Error('定时任务不存在');
    if (scheduler?.isRunning(item.id)) throw new Error('该任务正在运行');
    store.recordEvent('schedule', item.id, 'schedule.manual', { at: new Date().toISOString() });
    const result = await scheduledRunner.run({
      conversationTitle: `${item.name} · 手动`,
      agentId: item.agentId,
      prompt: item.prompt,
      origin: 'scheduled',
      scheduleId: item.id,
    });
    const now = new Date().toISOString();
    const outcome: { status: 'ok' | 'failed' | 'skipped'; at: string; reason?: string } =
      result.status === 'ok'
        ? { status: 'ok', at: now }
        : { status: result.status === 'skipped' ? 'skipped' : 'failed', at: now, reason: result.reason };
    schedules?.recordManualRun(item.id, outcome);
    emit();
    return outcome;
  }, scheduleAccess);
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
  scheduler?.stop();
  abortAdapterInstalls();
  if (recordingSession.isRecording())
    await stopRecording(autoRecordingName()).catch(() => undefined);
  stopReplay();
  agentReplay?.abort.abort();
  distillation.finish();
  clearTimeout(workspaceTimer);
  await workspace?.save().catch((error) => console.error('Workspace save failed', error));
  for (const pending of approvals.values()) {
    clearTimeout(pending.timer);
    if (pending.kind === 'browser') pending.reject(new Error('应用正在退出'));
    else if (pending.kind === 'schedule') pending.resolve(false);
    else pending.resolve({ outcome: { outcome: 'cancelled' } });
  }
  approvals.clear();
  try {
    await disconnectAgent();
  } catch {
    /* best-effort drain */
  }
  await processManager.stopAll();
  await stopExternalControl();
  await networkProxy?.close();
  networkProxy = undefined;
  store?.close();
}
// quitAndInstall 先关掉所有窗口，之后才触发 before-quit。设置窗口、以及「关闭窗口时退出」关掉时的
// 主窗口，只在 quitting 置位后才真的关，否则只是藏起来，退出就卡住了。
nativeAutoUpdater.on('before-quit-for-update', () => {
  quitting = true;
});
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void externalUrls.receive(url);
  });
});
app.on('before-quit', (event) => {
  quitting = true;
  if (draining) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});
// 装更新时由更新程序自己退出 Pilion：这里抢先退出，macOS 上可能等不到 Squirrel 登记「装完重新打开」。
app.on('window-all-closed', () => {
  if (!installingUpdate) app.quit();
});
app.on('activate', () => {
  if (window && !window.isDestroyed() && !window.isVisible()) window.show();
});
void app
  .whenReady()
  .then(init)
  .catch((error) => {
    console.error(error);
    app.quit();
  });
