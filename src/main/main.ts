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
import { AgentShield } from './browser/agent-shield.js';
import { AgentEmptyResponseError, isEmptyAgentReply, runPrompt } from './agents/prompt-runner.js';
import { sshLaunch } from './agents/ssh.js';
import {
  inspectLocalAgents,
  presetConfiguration,
  resolveLocalLaunch,
} from './agents/local-agents.js';
import {
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
  RECORDER_WORLD,
  RawEventSchema,
  RecordingLibrary,
  StepSchema,
  TrajectoryRecorder,
  buildDistillPrompt,
  buildRecorderScript,
  describeStep,
  extractSkillMarkdown,
  parseSkill,
  playSteps,
  reconcile,
  serializeSkill,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
  type PlayOutcome,
  type RecordingSummary,
  type Skill,
  type Step,
  type Trajectory,
} from './recording/index.js';
import type { Observation } from './browser/types.js';
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
  RecordingNoteSchema,
  RecordingStopSchema,
  SkillPlaySchema,
  SkillRenameSchema,
  SkillSaveSchema,
  SkillsPlayArgsSchema,
  ToolRequestSchema,
  type ReplayState,
  type SkillDetail,
  type SkillStepView,
  type AgentConfig,
  type AgentActivityPhase,
  type ChromeCookieImportResult,
  type ChromeCookieSources,
  type AgentStatus,
  type AppState,
  type ApprovalResponse,
  type ApprovalViewState,
  type Tab,
  type ToolRequest,
  type BrowserViewport,
  type Conversation,
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
type ActiveRecording = {
  tabId: string;
  recorder: TrajectoryRecorder;
  startedAt: string;
  /** 该文档预取的 observe 结果，用来给步骤取词；文档一换就清。 */
  observed?: Observation;
  observing?: Promise<void>;
  /** 每换一次文档加一：在途的那次 observe 回来时对不上号就直接作废。 */
  observeGeneration: number;
  lastPageUrl?: string;
  /** 队列排空之后才置位：在此之前排在队里的事件仍然要进轨迹。 */
  finished: boolean;
  /** 脚本消息与页面条目串行处理，顺序就是人的顺序。 */
  queue: Promise<void>;
};
let recording: ActiveRecording | undefined;
let library: RecordingLibrary;
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
/** 提炼那一轮：Agent 只准输出文档。 */
let distilling: { id: string; name: string; conversationId: string } | undefined;
/** 占位到 distilling 真正赋值为止：startDistillation 在第一个 await 前就把名额占住。 */
let distillStarting = false;
let pendingSkill:
  | {
      id: string;
      name: string;
      conversationId: string;
      prose: string;
      skill: Skill;
      markdown: string;
    }
  | undefined;
/** 提案对账时算出的「手工添加」序号集合，与 pendingSkill 同生共死。 */
let pendingSkillManual: number[] = [];
let distillationRejected:
  { id: string; name: string; conversationId: string; reason: string } | undefined;
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
  if (recording) throw new Error('正在录制，无法回放');
  if (distillStarting || distilling) throw new Error('正在提炼，请稍后');
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
  if (recording) throw new Error('正在录制，无法回放');
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
      pauseForHuman(outcome.humanReason);
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
  if (recording) throw new Error('正在录制，无法提炼');
  if (replayRunning()) throw new Error('正在回放技能，无法提炼');
  if (distillStarting || distilling) throw new Error('已有提炼在进行');
  // 读轨迹与重连都是 await，名额要在第一个 await 之前占住，否则两次点击都能进来。
  distillStarting = true;
  let session: {
    trajectory: Trajectory;
    markdown: string;
    name: string;
    live: Connection & { attachmentId: string };
    conversation: Conversation;
  };
  try {
    const { trajectory, markdown } = await library.read(id);
    const name = trajectory.meta.name;
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
    const live = requireAttachment();
    const conversation = workspace.current!;
    pendingSkill = undefined;
    pendingSkillManual = [];
    distillationRejected = undefined;
    distilling = { id, name, conversationId: conversation.id };
    session = { trajectory, markdown, name, live, conversation };
  } finally {
    distillStarting = false;
  }
  const { trajectory, markdown, name, live, conversation } = session;
  promptActive = true;
  promptCancelled = false;
  activeResponseId = undefined;
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
    const result = await runPrompt(buildDistillPrompt(name, markdown), {
      prompt: (prompt) => live.transport.prompt(prompt),
      messages: () => conversation.messages,
      cancelled: () => promptCancelled || connection !== live,
      onResult: (result) => log(`提炼回合结束：${result.stopReason}`),
      diagnostics: () => ({ agent: live.transport.capabilities.agentInfo }),
    });
    // 取消是返回值，不是异常：半截回合不能当成 Agent 交出来的成品。
    if (result.stopReason === 'cancelled' || promptCancelled || connection !== live)
      distillationRejected = { id, name, conversationId: conversation.id, reason: '已取消' };
    else {
      const reply = conversation.messages
        .slice(start)
        .filter((message) => message.role === 'assistant')
        .map((message) => message.text)
        .join('');
      acceptDistillation(id, name, conversation.id, reply, trajectory, live.config.id);
    }
  } catch (error) {
    distillationRejected = {
      id,
      name,
      conversationId: conversation.id,
      reason: promptCancelled ? '已取消' : readable(error),
    };
  } finally {
    distilling = undefined;
    promptActive = false;
    for (const message of conversation.messages)
      if (message.status === 'running') message.status = 'completed';
    if (connection === live) agentStatus = 'ready';
    emit();
  }
}

function acceptDistillation(
  id: string,
  name: string,
  conversationId: string,
  reply: string,
  trajectory: Trajectory,
  distilledBy: string,
): void {
  const reject = (reason: string) => {
    distillationRejected = { id, name, conversationId, reason };
  };
  const extracted = extractSkillMarkdown(reply);
  if (!extracted) return reject('回复里没有 ```json pilion-skill 代码块');
  // 元信息以 Pilion 为准：Agent 只需要给 about，其余键在解析前补齐。
  const metaOpen = /"meta"\s*:\s*\{/;
  if (!metaOpen.test(extracted)) return reject('回复的技能块缺少 meta');
  const withMeta = extracted.replace(
    metaOpen,
    () =>
      `"meta": { "app": "pilion", "version": 1, "kind": "skill", "name": ${JSON.stringify(name)}, "recordedAt": ${JSON.stringify(trajectory.meta.recordedAt)}, "distilledBy": ${JSON.stringify(distilledBy)}, "trajectory": "trajectory.md", `,
  );
  let parsed: ReturnType<typeof parseSkill>;
  try {
    parsed = parseSkill(withMeta);
  } catch (error) {
    return reject(readable(error));
  }
  const skill: Skill = {
    ...parsed.skill,
    meta: {
      ...parsed.skill.meta,
      name,
      recordedAt: trajectory.meta.recordedAt,
      distilledBy,
      trajectory: 'trajectory.md',
    },
  };
  const verdict = reconcile(skill, trajectory);
  if (!verdict.ok)
    return reject(
      `第 ${verdict.step} 步在轨迹里找不到依据（${
        verdict.reason === 'VALUE_CHANGED'
          ? '改写了输入值'
          : verdict.reason === 'URL_UNKNOWN'
            ? '轨迹里没去过这个地址'
            : '没有对应的动作'
      }）`,
    );
  // 预览就是按下保留时会写进文件的那份原文。
  pendingSkill = {
    id,
    name,
    conversationId,
    prose: parsed.prose,
    skill,
    markdown: serializeSkill(parsed.prose, skill),
  };
  pendingSkillManual = [];
  log(`提炼完成，等待保留：${name}`);
}

async function keepDistilled(): Promise<void> {
  const proposal = pendingSkill;
  if (!proposal) throw new Error('没有待保留的提炼结果');
  await library.writeSkill(proposal.id, proposal.prose, proposal.skill);
  pendingSkill = undefined;
  pendingSkillManual = [];
  store.recordEvent('skill', proposal.id, 'skill.kept', {
    distilledBy: proposal.skill.meta.distilledBy,
  });
  log(`技能已保留：${proposal.name}`);
  await refreshSkills();
}

function discardDistilled(): void {
  pendingSkill = undefined;
  pendingSkillManual = [];
  distillationRejected = undefined;
  emit();
}

/** 界面只给结构化操作，但「不能新建动作步骤」在这里执行，不依赖界面。 */
async function saveSkillEdit(input: {
  id: string;
  prose: string;
  steps: Record<string, unknown>[];
}): Promise<void> {
  if (!(await library.hasSkill(input.id))) throw new Error('该技能尚未提炼，先提炼再编辑');
  if (pendingSkill?.id === input.id || distilling?.id === input.id)
    throw new Error('正在提炼，请先保留或丢弃提案');
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
const recordingsPath = () => join(app.getPath('userData'), 'recordings');
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
  recording: recording
    ? {
        tabId: recording.tabId,
        steps: recording.recorder.counts.steps,
        unsupported: recording.recorder.counts.unsupported,
        startedAt: recording.startedAt,
      }
    : undefined,
  skills,
  replay: replay?.state,
  distillation: distilling
    ? { ...distilling, status: 'running' }
    : pendingSkill
      ? {
          id: pendingSkill.id,
          name: pendingSkill.name,
          conversationId: pendingSkill.conversationId,
          status: 'proposed',
          markdown: pendingSkill.markdown,
          steps: skillStepViews(pendingSkill.skill.steps, pendingSkillManual),
        }
      : distillationRejected
        ? { ...distillationRejected, status: 'rejected' }
        : undefined,
  agentReplay: agentReplay
    ? { name: agentReplay.name, step: agentReplay.step, total: agentReplay.total }
    : undefined,
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
      viewport.visible && tabId === activeTabId && item.model.url !== HOME && !item.model.error,
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
  if (recording?.tabId === tabId && item.model.loading) dropObservation(recording);
  if (
    recording?.tabId === tabId &&
    !item.model.loading &&
    item.model.url !== HOME &&
    item.model.url !== recording.lastPageUrl
  ) {
    const active = recording;
    active.lastPageUrl = item.model.url;
    active.queue = active.queue.then(() => recordPageEntry(active, tabId)).catch(() => undefined);
  }
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
    if (recording?.tabId === tabId) leaveRecordingTab(undefined);
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
async function closeTab(tabId: string, principal = USER_PRINCIPAL): Promise<void> {
  if (recording?.tabId === tabId) leaveRecordingTab(undefined);
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
    pauseForHuman(goal.lastReason);
    return;
  }
  task.status = 'completed';
  for (const message of conversation.messages)
    if (message.status === 'running') message.status = 'completed';
  activeResponseId = undefined;
  if (!promptActive) agentStatus = 'ready';
  emit();
}

/**
 * The Agent stops and the person takes the browser, with the task kept so it can be resumed.
 * A goal-capable Agent reaches this through its goal status; every other Agent reaches it by
 * calling browser.request_human, which is the only inbound channel plain ACP leaves open.
 */
function pauseForHuman(reason?: string | null): void {
  const conversation = workspace.current;
  const task = conversation?.task;
  if (!conversation || !task) return;
  task.status = 'manual';
  task.updatedAt = new Date().toISOString();
  task.handover = [];
  for (const message of conversation.messages)
    if (message.status === 'running') message.status = 'cancelled';
  agentStatus = 'ready';
  activeResponseId = undefined;
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
  if (!recording || recording.tabId === nextTabId) return;
  void stopRecording(autoRecordingName()).catch((error) => {
    lastError = `录制保存失败：${readable(error)}`;
    emit();
  });
}

async function refreshSkills(): Promise<void> {
  skills = await library.list();
  emit();
}

/** 只有人能开录制：入口只有可信 Renderer 的 IPC，MCP 里没有这个动词。 */
async function startRecording(): Promise<void> {
  if (recording) throw new Error('已经在录制了');
  if (replayRunning()) throw new Error('正在回放技能，无法同时录制');
  if (agentReplayStarting || agentReplay) throw new Error('Agent 正在回放技能');
  if (distillStarting || distilling) throw new Error('正在提炼，请稍后');
  if (isAgentBrowserActive() || promptActive || taskRunning())
    throw new Error('Agent 正在执行任务，先停止或接管后再录制');
  const tabId = requireActiveTab();
  const page = browser.registry.get(tabId).page;
  if (!page.startRecording) throw new Error('当前页面不支持录制');
  const bindingName = `pilion_${randomBytes(8).toString('hex')}`;
  const active: ActiveRecording = {
    tabId,
    recorder: new TrajectoryRecorder({ name: '未命名录制' }),
    startedAt: new Date().toISOString(),
    finished: false,
    observeGeneration: 0,
    queue: Promise.resolve(),
  };
  recording = active;
  try {
    await page.startRecording({
      script: buildRecorderScript(bindingName),
      bindingName,
      worldName: RECORDER_WORLD,
      onMessage: (payload) => enqueueRecordingEvent(active, payload),
    });
  } catch (error) {
    recording = undefined;
    throw error;
  }
  const model = pages.get(tabId)?.model;
  if (model && model.url !== HOME && !model.loading) {
    active.lastPageUrl = model.url;
    active.queue = active.queue.then(() => recordPageEntry(active, tabId)).catch(() => undefined);
  }
  store.recordEvent('recording', tabId, 'recording.started', { startedAt: active.startedAt });
  log('开始录制');
  emit();
}

/** 文档换了：手里那份 observe 作废，在途的那次也不要再落地。 */
function dropObservation(active: ActiveRecording): void {
  active.observeGeneration += 1;
  active.observed = undefined;
  active.observing = undefined;
}

/** 只有还和当前文档同一个 epoch 的 observe 才配给步骤取词。 */
function freshObservation(active: ActiveRecording): Observation | undefined {
  const observation = active.observed;
  if (!observation || !browser.registry.has(active.tabId)) return undefined;
  return observation.documentEpoch === browser.registry.get(active.tabId).documentEpoch
    ? observation
    : undefined;
}

function enqueueRecordingEvent(active: ActiveRecording, payload: string): void {
  active.queue = active.queue
    .then(async () => {
      if (active.finished) return;
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return;
      }
      const parsed = RawEventSchema.safeParse(raw);
      if (!parsed.success) return;
      await active.observing?.catch(() => undefined);
      active.recorder.raw(parsed.data, freshObservation(active));
      emit();
    })
    .catch(() => undefined);
}

/** 页面加载完成：记 URL、标题与正文摘录，并预取一次 observe 供后续步骤取词。 */
async function recordPageEntry(active: ActiveRecording, tabId: string): Promise<void> {
  if (active.finished || !browser.registry.has(tabId)) return;
  const page = browser.registry.get(tabId).page;
  const snapshot = await page.snapshot();
  const text = (await page.readText?.().catch(() => '')) ?? '';
  active.recorder.page({ url: snapshot.url, title: snapshot.title, text });
  dropObservation(active);
  const generation = active.observeGeneration;
  active.observing = browser
    .observe({ principalId: USER_PRINCIPAL, tabId })
    .then((observation) => {
      if (!active.finished && active.observeGeneration === generation)
        active.observed = observation;
    })
    .catch(() => undefined);
  emit();
}

/** 停止并保存。没有录到步骤时不建文件，返回 undefined。 */
async function stopRecording(name: string): Promise<string | undefined> {
  const active = recording;
  if (!active) throw new Error('当前没有在录制');
  recording = undefined;
  const page = browser.registry.has(active.tabId)
    ? browser.registry.get(active.tabId).page
    : undefined;
  await page?.stopRecording?.().catch(() => undefined);
  // 通道的监听在 stop() 里同步摘掉，所以队列排空之后不会再有事件；排空之前的都还算数。
  await active.queue.catch(() => undefined);
  active.finished = true;
  const trajectory = active.recorder.finish();
  const hasSteps = trajectory.entries.some((entry) => entry.kind === 'step');
  const id = hasSteps ? await library.create(name, trajectory) : undefined;
  store.recordEvent('recording', active.tabId, 'recording.stopped', {
    id,
    entries: trajectory.entries.length,
  });
  log(
    id
      ? active.recorder.capped
        ? `录制已保存（已达到步骤上限）：${name}`
        : `录制已保存：${name}`
      : '录制结束，没有记录到任何步骤',
  );
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

async function skillDetail(id: string): Promise<SkillDetail> {
  const { trajectory, markdown } = await library.read(id);
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
  };
}

async function executeTool(request: ToolRequest, actor?: Actor): Promise<unknown> {
  if (recording) throw new Error('用户正在录制，浏览器工具暂不可用');
  if (!actor && distilling) throw new Error('提炼期间不提供浏览器工具，请只输出文档');
  // 回放也在驾驶同一个标签：没带身份的调用都是 Agent 从 MCP 来的，和录制一样挡住。
  if (!actor && replayRunning()) throw new Error('正在回放技能，浏览器工具暂不可用');
  if (!actor && promptCancelled) throw new Error('任务已停止，浏览器操作已取消');
  if (!actor && toolExecutions === 0 && agentStatus === 'ready') {
    restoreReadyAfterTools = true;
    agentStatus = 'running';
  }
  toolExecutions += 1;
  emit();
  try {
    return await runTool(request, actor ?? requireAttachment());
  } finally {
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
  const who = actor.principal === USER_PRINCIPAL ? '回放' : 'Agent';
  log(`${who} 正在执行：${request.name}`);
  const current = actor;
  if (request.name === 'browser.request_human') {
    if (actor.principal === USER_PRINCIPAL) throw new Error('人工回放不能调用 request_human');
    const reason = String((request.args as { reason?: unknown }).reason ?? '').slice(0, 500);
    pauseForHuman(reason);
    log(`Agent 请求人工介入：${reason}`);
    return { handedOver: true, message: '浏览器已交回给用户，请结束本回合并等待其继续任务。' };
  }
  const skillPlay =
    request.name === 'browser.skills.play' ? await loadSkillForPlay(request, actor) : undefined;
  // 载入成功就占住了名额：从这里到执行结束的任何抛出都要把它还回去。
  try {
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
          summary: skillPlay
            ? skillApprovalSummary(skillPlay.skill)
            : trustedApprovalSummary(command, trustedElement, effect),
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
    skill.meta.about,
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
  library = new RecordingLibrary(recordingsPath());
  skills = await library.list().catch(() => []);
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
  if (recording) throw new Error('正在录制，请先停止录制再发送任务');
  if (replayRunning()) throw new Error('正在回放技能，请先停止回放');
  const current = requireAttachment();
  if (promptActive || connectionBusy || agentStatus !== 'ready')
    throw new Error('请等待当前任务结束');
  if (workspace.current?.agentId !== current.config.id)
    workspace.create(randomUUID(), current.config.id);
  const conversation = workspace.current!;
  if (resuming && conversation.task?.status !== 'manual') throw new Error('该任务不能继续');
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
      if (resuming && (handoverNote || cursorNote || text))
        await current.transport.prompt(resumeText);
      return { stopReason: 'end_turn' };
    }
    runningTask.executionMode = 'prompt';
    const promptText = resuming ? resumeText : text;
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
  // 断开的连接会让下面两处提前 return：播放器的唯一取消口在那之前就得按下。
  agentReplay?.abort.abort();
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
  handle(IPC.tabNavigate, NavigateInputSchema, async (value) => {
    const tabId = requireActiveTab();
    const result = await browser.navigate({ principalId: USER_PRINCIPAL, tabId, url: value.url });
    if (recording?.tabId === tabId) {
      recording.recorder.navigate(result.url);
      emit();
    }
    return result;
  });
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
    if (recording) throw new Error('正在录制，请先停止录制再发送任务');
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
  // 录制与技能库（只有可信 Renderer 能开录制；MCP 没有这个动词）
  handle(IPC.recordingStart, undefined, () => startRecording());
  handle(IPC.recordingStop, RecordingStopSchema, (value) => stopRecording(value.name));
  handle(IPC.recordingNote, RecordingNoteSchema, (value) => {
    if (!recording) throw new Error('当前没有在录制');
    recording.recorder.note(value.text);
    emit();
  });
  handle(IPC.skillsRead, IdInputSchema, (value) => skillDetail(value.id));
  handle(IPC.skillsPlay, SkillPlaySchema, (value) => startReplay(value.id, value.fromStep));
  handle(IPC.skillsResume, undefined, () => resumeReplay());
  handle(IPC.skillsStop, undefined, () => stopReplay());
  handle(IPC.skillsDistill, IdInputSchema, (value) => startDistillation(value.id));
  handle(IPC.skillsKeep, undefined, () => keepDistilled());
  handle(IPC.skillsDiscard, undefined, () => discardDistilled());
  handle(IPC.skillsSave, SkillSaveSchema, (value) => saveSkillEdit(value));
  handle(IPC.skillsRemove, IdInputSchema, async (value) => {
    if (replay?.id === value.id && replayRunning()) throw new Error('正在回放，无法删除');
    if (pendingSkill?.id === value.id || distilling?.id === value.id)
      throw new Error('正在提炼，无法删除');
    await library.remove(value.id);
    await refreshSkills();
  });
  handle(IPC.skillsRename, SkillRenameSchema, async (value) => {
    // 改名会重写 skill.md，提案还在手上时那份文件随时会被保留覆盖掉。
    if (pendingSkill?.id === value.id || distilling?.id === value.id)
      throw new Error('正在提炼，请先保留或丢弃提案');
    await library.rename(value.id, value.name);
    await refreshSkills();
  });
  handle(IPC.skillsShow, IdInputSchema, (value) => shell.showItemInFolder(library.path(value.id)));
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
  if (recording) await stopRecording(autoRecordingName()).catch(() => undefined);
  stopReplay();
  agentReplay?.abort.abort();
  discardDistilled();
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
