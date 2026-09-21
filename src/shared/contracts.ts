import { z } from 'zod';
import { LOCAL_AGENT_IDS } from './local-agents.js';

export const LocalAgentPresetSchema = z.enum(LOCAL_AGENT_IDS);
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
export interface SkillDetail {
  id: string;
  name: string;
  recordedAt: string;
  markdown: string;
  steps: { index: number; kind: string; text: string; unsupported?: string; ambiguous?: boolean }[];
}
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

const NewEffectArgsSchemas = {
  'browser.select': SelectArgsSchema,
  'browser.check': CheckArgsSchema,
  'browser.press': PressArgsSchema,
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
export const TaskInputSchema = z.object({ text: z.string().trim().min(1).max(100_000) }).strict();
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
}
export interface Conversation {
  task?: ConversationTask;
  id: string;
  title: string;
  agentId?: string;
  acpSessionId?: string;
  updatedAt: string;
  messages: ConversationMessage[];
}
export const PermissionModeSchema = z.enum(['full', 'ask']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const PermissionInputSchema = z.object({ mode: PermissionModeSchema }).strict();
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
export interface ApprovalViewState {
  approvalId: string;
  tool: string;
  summary: string;
  state: 'pending' | 'approved' | 'denied' | 'stale' | 'expired';
  statusText?: string;
  nonce?: string;
  actionDigest?: string;
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
export interface AppState {
  tabs: Tab[];
  activeTabId?: string;
  agents: AgentConfig[];
  agentStatus: AgentStatus;
  agentActivityPhase?: AgentActivityPhase;
  attachmentStatus: AttachmentStatus;
  approvals: ApprovalViewState[];
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
  permissionMode?: PermissionMode;
  recording?: RecordingState;
  skills?: RecordingSummary[];
  replay?: ReplayState;
}

export const IPC = Object.freeze({
  getState: 'app:get-state',
  state: 'app:state',
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
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingNote: 'recording:note',
  skillsRead: 'skills:read',
  skillsRemove: 'skills:remove',
  skillsRename: 'skills:rename',
  skillsShow: 'skills:show',
  skillsPlay: 'skills:play',
  skillsResume: 'skills:resume',
  skillsStop: 'skills:stop',
});
