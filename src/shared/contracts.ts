import { z } from 'zod';
import { LOCAL_AGENT_IDS, type LocalAgentPreset } from './local-agents.js';
import type { AppSettings } from './settings.js';
import type { ScheduledPrompt } from './schedule.js';

export const LocalAgentPresetSchema = z.enum(LOCAL_AGENT_IDS);
/**
 * 打开设置窗口时要停在哪：主窗口里的 Agent 入口带上 agent 页和选中的预设，
 * returnOnConnect 表示连上之后收起设置窗口、回到浏览器。⌘, 打开时什么都不带。
 */
export const PreferencesTargetSchema = z
  .object({
    pane: z.enum(['general', 'browser', 'shortcuts', 'schedules', 'agent']).optional(),
    preset: LocalAgentPresetSchema.optional(),
    returnOnConnect: z.boolean().optional(),
  })
  .strict();
export type PreferencesTarget = z.infer<typeof PreferencesTargetSchema>;
export const BrowsingDataClearSchema = z
  .object({
    history: z.boolean(),
    downloads: z.boolean(),
    cookies: z.boolean(),
    cache: z.boolean(),
  })
  .strict()
  .refine((value) => Object.values(value).some(Boolean), '请选择要清除的数据');
export type BrowsingDataClearInput = z.infer<typeof BrowsingDataClearSchema>;
export interface BrowsingDataClearResult {
  cleared: boolean;
}
export interface DefaultBrowserStatus {
  supported: boolean;
  isDefault: boolean;
}
export const LocalAgentInputSchema = z
  .object({
    preset: LocalAgentPresetSchema,
    nodePath: z.string().max(4096).optional(),
    cwd: z.string().max(4096).optional(),
  })
  .strict();
export const LocalInspectSchema = z.object({ nodePath: z.string().max(4096).optional() }).strict();

export const AgentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  authMethodId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'ssh']).optional(),
  preset: LocalAgentPresetSchema.optional(),
  nodePath: z.string().max(4096).optional(),
  ssh: z
    .object({
      host: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/)
        .max(253),
      port: z.number().int().min(1).max(65535).default(22),
      identityFile: z.string().optional(),
    })
    .strict()
    .optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ChromeCookieImportSchema = z
  .object({ chromeProfile: z.string().min(1).max(120) })
  .strict();
export type ChromeCookieImportInput = z.infer<typeof ChromeCookieImportSchema>;

export interface ChromeCookieSources {
  /** False on platforms whose Chrome key store this build cannot read. */
  supported: boolean;
  reason?: string;
  profiles: { id: string; name: string }[];
}

export interface ChromeCookieImportResult {
  profile: string;
  /** Cookies present in the workspace after the import, which is what a site will actually see. */
  stored: number;
  domains: number;
  /** Rows whose value could not be decrypted, and rows the session refused. */
  unreadable: number;
  rejected: number;
}

export interface RecordingSummary {
  id: string;
  name: string;
  steps: number;
  unsupported: number;
  needsHuman: number;
  recordedAt: string;
  /** 有 skill.md 才算已提炼；Agent 只看得到已提炼的。 */
  distilled: boolean;
  /** 有事件日志（events.jsonl）才能在读取时按日志自愈轨迹；第一期的老录制没有。 */
  hasEvents: boolean;
  /** 这份录制有一条还没被看过的重算提示：list() 对它持续报 true，直到详情把它带给人看过为止，与这一次是否真的重算无关。 */
  recomputed?: boolean;
  about?: string;
  /** 文件读不出来时的原因；有它的行不能播放，但仍然列出来让人去修。 */
  error?: string;
}
export interface RecordingState {
  tabId: string;
  steps: number;
  unsupported: number;
  startedAt: string;
}
export interface ReplayState {
  id: string;
  name: string;
  /** 1 起，当前正在执行或刚停在的步骤。 */
  step: number;
  total: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  /** paused 时是需要人做的事；failed 时是原因。 */
  message?: string;
  nextStep?: number;
}
export interface AgentReplayState {
  name: string;
  step: number;
  total: number;
}
export interface SkillStepView {
  index: number;
  kind: string;
  text: string;
  unsupported?: string;
  ambiguous?: boolean;
  /** 没有轨迹依据的步骤（人直接改文件加的）。 */
  manual?: boolean;
  /** 原始步骤对象，编辑时原样交回主进程校验。 */
  raw: Record<string, unknown>;
}
export interface SkillDetail {
  id: string;
  name: string;
  recordedAt: string;
  /** 轨迹 md 原文。 */
  markdown: string;
  distilled: boolean;
  about?: string;
  /** 已提炼时：块上方散文与 skill.md 原文。 */
  prose?: string;
  skillMarkdown?: string;
  steps: SkillStepView[];
  /** 打开这份录制时告知了一条待确认的重算提示；确认后从技能库的集合里移出，以后的读取都不会再带上它。 */
  recomputed?: boolean;
}
export interface DistillationState {
  id: string;
  name: string;
  status: 'running' | 'proposed' | 'rejected';
  conversationId: string;
  markdown?: string;
  steps?: SkillStepView[];
  reason?: string;
}
/**
 * 普通对话回合里 Agent 自己吐出来的 ```json pilion-skill 块。它只是「提案」：
 * 没有对应的录制轨迹，所以主进程从不凭它直接落盘，也不跑四条对账（没有轨迹可对）。
 * 人在界面上把它指给某份**已提炼**的技能当修改，主进程才用 validateSkillEdit 把关——
 * 提案里的每个动作步必须在目标技能里找得到同 kind 同目标的一条，不能新增动作。
 */
export interface SkillProposalView {
  proposalId: string;
  conversationId: string;
  /** 产出这块的那条 Agent 消息 id，便于界面定位。 */
  messageId: string;
  name: string;
  stepCount: number;
  /** 给人预览的散文 + 步骤摘要；正式 diff 在采用时由主进程对目标技能重算。 */
  preview: string;
}
export const SkillProposalApplySchema = z
  .object({ proposalId: z.string().min(1).max(64), targetSkillId: z.string().min(1).max(60) })
  .strict();
export const SkillProposalDiscardSchema = z
  .object({ proposalId: z.string().min(1).max(64) })
  .strict();
export const RecordingStopSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const RecordingNoteSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export const SkillPlaySchema = z
  .object({
    id: z.string().min(1).max(60),
    fromStep: z.number().int().min(1).max(2000).optional(),
  })
  .strict();
export const SkillRenameSchema = z
  .object({ id: z.string().min(1).max(60), name: z.string().trim().min(1).max(120) })
  .strict();
export const SkillSaveSchema = z
  .object({
    id: z.string().min(1).max(60),
    prose: z.string().max(20_000),
    /** 步骤原样交回主进程，由 StepSchema 与 validateSkillEdit 把关。 */
    steps: z.array(z.record(z.string(), z.unknown())).max(500),
  })
  .strict();
export const SkillEventsArgsSchema = z.object({ id: z.string().min(1).max(60) }).strict();

export const ToolNameSchema = z.enum([
  'browser.snapshot',
  'browser.screenshot',
  'browser.page_info',
  'browser.navigate',
  'browser.tabs.list',
  'browser.tabs.open',
  'browser.tabs.activate',
  'browser.tabs.close',
  'browser.observe',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.check',
  'browser.press',
  'browser.request_human',
  'browser.skills.list',
  'browser.skills.play',
  'browser.schedule.create',
  'browser.schedule.list',
  'browser.schedule.delete',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ElementRefSchema = z
  .object({
    id: z.string().min(1).max(256),
    tabId: z.string().min(1).max(256),
    frameId: z.string().min(1).max(256),
    documentEpoch: z.number().int().nonnegative(),
    frameEpoch: z.number().int().nonnegative(),
    localFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .or(z.string().min(1).max(512)),
  })
  .strict();
export const SelectArgsSchema = z
  .object({
    tabId: z.string().min(1).max(256).optional(),
    elementRef: ElementRefSchema,
    value: z.string().min(1).max(10_000),
  })
  .strict();
export const CheckArgsSchema = z
  .object({
    tabId: z.string().min(1).max(256).optional(),
    elementRef: ElementRefSchema,
    checked: z.boolean(),
  })
  .strict();
export const PressKeySchema = z.enum([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  'Space',
]);
export const PressModifierSchema = z.enum(['Shift']);
export const PressArgsSchema = z
  .object({
    tabId: z.string().min(1).max(256).optional(),
    elementRef: ElementRefSchema,
    key: PressKeySchema,
    modifiers: z.array(PressModifierSchema).max(1).default([]),
  })
  .strict();

export const SkillsPlayArgsSchema = z
  .object({
    skillId: z.string().min(1).max(60),
    fromStep: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const NewEffectArgsSchemas = {
  'browser.select': SelectArgsSchema,
  'browser.check': CheckArgsSchema,
  'browser.press': PressArgsSchema,
  'browser.skills.play': SkillsPlayArgsSchema,
} as const;
export const ToolRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    name: ToolNameSchema,
    args: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const schema = NewEffectArgsSchemas[request.name as keyof typeof NewEffectArgsSchemas];
    if (!schema) return;
    const result = schema.safeParse(request.args);
    if (!result.success) {
      for (const issue of result.error.issues)
        context.addIssue({ ...issue, path: ['args', ...issue.path] });
    }
  });
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const AgentConfigInputSchema = AgentConfigSchema.strict();
export const IdInputSchema = z.object({ id: z.string().min(1).max(256) }).strict();
export const UrlInputSchema = z.object({ url: z.string().min(1).max(8192).optional() }).strict();
export const NavigateInputSchema = z.object({ url: z.string().min(1).max(8192) }).strict();
export const FindInputSchema = z
  .object({
    text: z.string().max(1_000),
    forward: z.boolean().default(true),
    newSearch: z.boolean().default(false),
  })
  .strict();
/**
 * 一次任务可带的图片附件。渲染层先在本地限数量/大小/类型，主进程这里再用 Zod 复校一遍：
 * 白名单类型、单张字节数、张数都以主进程为准，渲染层的提示只是更快。
 * data 是不带 data: 前缀的 base64；之所以把 base64 直接过桥，是因为附件只活在这一回合里——
 * 持久化消息只留元数据（见 ConversationMessage.attachments），不把图片本体写进工作区 JSON。
 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGES_PER_PROMPT = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PromptAttachmentSchema = z
  .object({
    mimeType: z.enum(IMAGE_MIME_TYPES),
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3))
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, '图片必须是 base64'),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type PromptAttachment = z.infer<typeof PromptAttachmentSchema>;
export const TaskInputSchema = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    attachments: z.array(PromptAttachmentSchema).max(MAX_IMAGES_PER_PROMPT).optional(),
  })
  .strict();
export const ResumeTaskInputSchema = z
  .object({ text: z.string().trim().max(100_000).default('') })
  .strict();
export const ConversationTaskSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  goal: z.string(),
  status: z.enum(['running', 'manual', 'stopped', 'completed', 'failed']),
  executionMode: z.enum(['prompt', 'goal']).optional(),
  agentGoalStatus: z.enum(['active', 'paused', 'blocked', 'limited', 'complete']).optional(),
  lastReason: z.string().nullable().optional(),
  /** What the person did while they held the browser, replayed to the Agent when it resumes. */
  handover: z.array(z.string().max(2048)).max(50).optional(),
  /** Where an Agent-driven replay handed the browser back, so resume can say which step to continue from. */
  replayCursor: z
    .object({
      skillId: z.string().min(1).max(60),
      name: z.string().max(120),
      nextStep: z.number().int().min(1).max(500),
    })
    .strict()
    .optional(),
  updatedAt: z.string(),
});
export type ConversationTask = z.infer<typeof ConversationTaskSchema>;
export const ViewportSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    visible: z.boolean(),
  })
  .strict();
export type BrowserViewport = z.infer<typeof ViewportSchema>;
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'thought' | 'tool' | 'system';
  text: string;
  time: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * 用户消息随附的图片，只持久化元数据，不存 base64 本体。
   * 取舍：图片本体可能几 MB，写进工作区 JSON 会让对话历史迅速膨胀；而附件只在发送那一回合
   * 有意义（已随 ACP 发给 Agent），过后回放历史不需要原图。因此这里只留名字/类型/大小，
   * 重新打开对话时能看到「这条消息带过哪些图」，但不会重新发送它们。
   */
  attachments?: { name: string; mimeType: string; size: number }[];
}
export interface Conversation {
  task?: ConversationTask;
  id: string;
  title: string;
  agentId?: string;
  /** 最后一次已知的 Agent 名称快照：配置删除后面板仍能显示「原来是哪个 Agent」。 */
  agentName?: string;
  acpSessionId?: string;
  updatedAt: string;
  messages: ConversationMessage[];
  /** 由定时任务在后台新建的对话：这一类对话里禁止再调用 browser.schedule.*。 */
  origin?: 'scheduled';
}
export const PermissionModeSchema = z.enum(['full', 'ask']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const PermissionInputSchema = z.object({ mode: PermissionModeSchema }).strict();
export const UseAgentForConversationSchema = z
  .object({ conversationId: z.string(), agentId: z.string() })
  .strict();
export interface SavedPage {
  url: string;
  title: string;
  time: string;
}
export interface FindResult {
  tabId: string;
  activeMatchOrdinal: number;
  matches: number;
}
export interface DownloadRecord {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  status: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  startedAt: string;
}
export const ApprovalResponseSchema = z
  .object({
    approvalId: z.string().uuid(),
    nonce: z.string().min(32).max(256),
    actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'deny']),
    gestureToken: z.string().uuid(),
  })
  .strict();
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export type AgentStatus =
  'not_configured' | 'starting' | 'ready' | 'running' | 'stopping' | 'error' | 'disconnected';
export type AgentActivityPhase = 'think' | 'act' | 'confirm';
export type AttachmentStatus = 'none' | 'attached' | 'detached';
export interface Tab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomPercent: number;
  crashed: boolean;
  error?: string;
}
/** 每条对话的 Agent 连接状态。'none'=无 agentId；'unavailable'=配置已删除/禁用；'capacity'=并发上限。 */
export interface ConversationAgentView {
  conversationId: string;
  agentId?: string;
  agentName?: string;
  state: 'none' | 'connecting' | 'ready' | 'running' | 'unavailable' | 'capacity' | 'failed';
  error?: string;
  notice?: 'session_reset' | 'new_session_no_context';
  sessionRestored?: boolean;
}
export interface ApprovalViewState {
  approvalId: string;
  tool: string;
  summary: string;
  state: 'pending' | 'approved' | 'denied' | 'stale' | 'expired';
  statusText?: string;
  nonce?: string;
  actionDigest?: string;
  /** 这条审批来自哪个会话：面板按会话过滤，不串到别的对话里。 */
  conversationId?: string;
}
/** 一个会话里 Agent 正在操作的标签；侧栏据此给多个 Agent 标签各自的归属徽标。 */
export interface AgentTabState {
  conversationId: string;
  tabId: string;
  running: boolean;
}
export interface ToolError {
  code:
    | 'TAB_NOT_FOUND'
    | 'STALE_ELEMENT'
    | 'INVALID_ARGUMENT'
    | 'NAVIGATION_FAILED'
    | 'UNSUPPORTED_PAGE_STRUCTURE'
    | 'ACTION_TIMEOUT'
    | 'PERMISSION_DENIED'
    | 'AGENT_DISCONNECTED'
    | 'APPROVAL_REQUIRED'
    | 'APPROVAL_DENIED'
    | 'APPROVAL_STALE'
    | 'POLICY_DENIED'
    | 'UNSUPPORTED_ELEMENT'
    | 'OPTION_NOT_FOUND'
    | 'KEY_NOT_ALLOWED'
    | 'GRANT_REQUIRED'
    | 'INVALID_GRANT'
    | 'STALE_FENCING_TOKEN'
    | 'PREPARATION_EXPIRED'
    | 'DANGEROUS_URL'
    | 'PRIVATE_NETWORK_BLOCKED'
    | 'PREPARATION_NOT_FOUND'
    | 'EXECUTION_TOKEN_USED'
    | 'INTERNAL_ERROR';
  message: string;
  retryable: boolean;
  requestId: string;
}
/** 自动更新进行到哪一步。开发模式与 e2e 不检查更新，状态是 unsupported。 */
export type UpdateStatus =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  // 只提示、不下载（Linux deb）：url 是该版本的 Release 页面，由主进程给出。
  | { kind: 'available'; version: string; url: string }
  | { kind: 'error'; message: string; at: number };
export interface UpdateState {
  currentVersion: string;
  status: UpdateStatus;
}
export interface AdapterInstallState {
  presetId: LocalAgentPreset;
  name: string;
  package: string;
  startedAt: number;
  downloadedBytes?: number;
}
export interface AppState {
  tabs: Tab[];
  activeTabId?: string;
  /**
   * Agent 这次任务正在操作的那个标签页。人自己切走之后它不会跟着走，侧栏据此标出「AI 操作中」；
   * Agent 空闲、任务结束、接管或断开时整个字段消失。单会话视图保留这个字段；多会话明细看 agentTabs。
   */
  agentTabId?: string;
  /** 每个会话各自的 Agent 操作标签与运行状态：侧栏可同时看到多个会话的 Agent 标签归属。 */
  agentTabs?: AgentTabState[];
  agents: AgentConfig[];
  agentStatus: AgentStatus;
  adapterInstall?: AdapterInstallState;
  agentActivityPhase?: AgentActivityPhase;
  attachmentStatus: AttachmentStatus;
  approvals: ApprovalViewState[];
  pendingApprovalsByConversation: Record<string, number>;
  /** 每条对话的 Agent 连接状态：面板按此渲染状态文字、重试按钮、选用其他 Agent 下拉。 */
  conversationAgents: Record<string, ConversationAgentView>;
  events: string[];
  error?: string;
  connectedAgentId?: string;
  conversations?: Conversation[];
  activeConversationId?: string;
  bookmarks?: SavedPage[];
  history?: SavedPage[];
  downloads?: DownloadRecord[];
  findResult?: FindResult;
  canReopenClosedTab?: boolean;
  agentModels?: { value: string; name: string }[];
  agentModes?: { value: string; name: string }[];
  agentModel?: string;
  agentMode?: string;
  /**
   * Agent 在 initialize 里公布的 promptCapabilities.image。缺省/undefined 一律当作不支持：
   * 界面据此禁用图片附件并明确提示，而不是把图发出去再被 Agent 静默丢弃。
   */
  agentImageCapable?: boolean;
  /** 普通对话里 Agent 提出、待人确认的技能修改提案（未落盘）。 */
  skillProposals?: SkillProposalView[];
  permissionMode?: PermissionMode;
  recording?: RecordingState;
  skills?: RecordingSummary[];
  /** 定时任务列表，随状态广播，设置页「定时任务」分区从这里读。 */
  schedules?: ScheduledPrompt[];
  replay?: ReplayState;
  distillation?: DistillationState;
  agentReplay?: AgentReplayState;
  /** 全局设置随状态一起广播，主窗口与设置窗口都从这里读，改了立刻两边生效。 */
  settings?: AppSettings;
  /** 下载位置的显示路径，主进程把用户主目录缩写为 ~。 */
  downloadLocation?: string;
  /** 自动更新的状态，主窗口的提示条与设置窗口的「更新」分区都从这里读。 */
  update?: UpdateState;
  /** 当前活动的外部 CLI / MCP 连接（外部控制通道开启时才有）。 */
  externalConnections?: ExternalConnectionView[];
}

export interface ExternalConnectionView {
  principal: string;
  client: string;
  connectedAt: string;
}
/** 含 token 的完整 MCP 配置：只通过设置窗口按需 IPC 下发，绝不随 state 广播到主窗口。 */
export interface ExternalMcpConfigView {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const IPC = Object.freeze({
  getState: 'app:get-state',
  state: 'app:state',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsOpen: 'settings:open',
  defaultBrowserGet: 'default-browser:get',
  defaultBrowserSet: 'default-browser:set',
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
  downloadChooseDirectory: 'downloads:choose-directory',
  downloadResetDirectory: 'downloads:reset-directory',
  browsingDataClear: 'browsing-data:clear',
  chromeCookieSources: 'cookies:chrome-sources',
  chromeCookieImport: 'cookies:chrome-import',
  agentSave: 'agents:save',
  agentConnect: 'agents:connect',
  agentDisconnect: 'agents:disconnect',
  agentAttach: 'agents:attach',
  agentDetach: 'agents:detach',
  agentTask: 'agents:task',
  agentCancel: 'agents:cancel',
  agentTakeOver: 'agents:take-over',
  agentResume: 'agents:resume',
  agentRemove: 'agents:remove',
  viewport: 'browser:viewport',
  conversationNew: 'conversation:new',
  conversationSelect: 'conversation:select',
  bookmarkToggle: 'bookmark:toggle',
  historyClear: 'history:clear',
  approvalRequest: 'approval:request',
  approvalGesture: 'approval:gesture',
  approvalRespond: 'approval:respond',
  agentSetMode: 'agents:set-mode',
  agentSetModel: 'agents:set-model',
  retryConversation: 'agents:retry-conversation',
  useAgentForConversation: 'agents:use-agent-for-conversation',
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
  externalDisconnect: 'external:disconnect',
  externalMcpConfig: 'external:mcp-config',
  skillsProposalApply: 'skills:proposal-apply',
  skillsProposalDiscard: 'skills:proposal-discard',
  scheduleList: 'schedule:list',
  scheduleSave: 'schedule:save',
  scheduleDelete: 'schedule:delete',
  scheduleSetEnabled: 'schedule:set-enabled',
  scheduleRunNow: 'schedule:run-now',
  schedulePreview: 'schedule:preview',
});
