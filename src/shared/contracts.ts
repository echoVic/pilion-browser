import { z } from 'zod';
import { LOCAL_AGENT_IDS } from './local-agents.js';

export const LocalAgentPresetSchema = z.enum(LOCAL_AGENT_IDS);
export const LocalAgentInputSchema = z.object({
  preset: LocalAgentPresetSchema, nodePath: z.string().max(4096).optional(), cwd: z.string().max(4096).optional(),
}).strict();
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
  ssh: z.object({
    host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._@-]*$/).max(253),
    port: z.number().int().min(1).max(65535).default(22),
    identityFile: z.string().optional(),
  }).strict().optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ToolNameSchema = z.enum([
  'browser.page_info', 'browser.navigate', 'browser.tabs.list', 'browser.tabs.open',
  'browser.tabs.activate', 'browser.tabs.close', 'browser.observe', 'browser.click', 'browser.type',
  'browser.select', 'browser.check', 'browser.press',
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ElementRefSchema = z.object({
  id: z.string().min(1).max(256),
  tabId: z.string().min(1).max(256),
  frameId: z.string().min(1).max(256),
  documentEpoch: z.number().int().nonnegative(),
  frameEpoch: z.number().int().nonnegative(),
  localFingerprint: z.string().regex(/^[a-f0-9]{64}$/i).or(z.string().min(1).max(512)),
}).strict();
export const SelectArgsSchema = z.object({
  tabId: z.string().min(1).max(256).optional(),
  elementRef: ElementRefSchema,
  value: z.string().min(1).max(10_000),
}).strict();
export const CheckArgsSchema = z.object({
  tabId: z.string().min(1).max(256).optional(),
  elementRef: ElementRefSchema,
  checked: z.boolean(),
}).strict();
export const PressKeySchema = z.enum([
  'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Space',
]);
export const PressModifierSchema = z.enum(['Shift']);
export const PressArgsSchema = z.object({
  tabId: z.string().min(1).max(256).optional(),
  elementRef: ElementRefSchema,
  key: PressKeySchema,
  modifiers: z.array(PressModifierSchema).max(1).default([]),
}).strict();

const NewEffectArgsSchemas = {
  'browser.select': SelectArgsSchema,
  'browser.check': CheckArgsSchema,
  'browser.press': PressArgsSchema,
} as const;
export const ToolRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  name: ToolNameSchema,
  args: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
}).strict().superRefine((request, context) => {
  const schema = NewEffectArgsSchemas[request.name as keyof typeof NewEffectArgsSchemas];
  if (!schema) return;
  const result = schema.safeParse(request.args);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ ...issue, path: ['args', ...issue.path] });
  }
});
export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export const AgentConfigInputSchema = AgentConfigSchema.strict();
export const IdInputSchema = z.object({ id: z.string().min(1).max(256) }).strict();
export const UrlInputSchema = z.object({ url: z.string().min(1).max(8192).optional() }).strict();
export const NavigateInputSchema = z.object({ url: z.string().min(1).max(8192) }).strict();
export const TaskInputSchema = z.object({ text: z.string().trim().min(1).max(100_000) }).strict();
export const ViewportSchema = z.object({
  x: z.number().int().min(0), y: z.number().int().min(0),
  width: z.number().int().min(0), height: z.number().int().min(0), visible: z.boolean(),
}).strict();
export type BrowserViewport = z.infer<typeof ViewportSchema>;
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'thought' | 'tool' | 'system';
  text: string;
  time: string;
  status?: 'running' | 'completed' | 'failed' | 'cancelled';
}
export interface Conversation {
  id: string; title: string; agentId?: string; updatedAt: string;
  messages: ConversationMessage[];
}
export const PermissionModeSchema = z.enum(['full', 'ask']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export const PermissionInputSchema = z.object({ mode: PermissionModeSchema }).strict();
export interface SavedPage { url: string; title: string; time: string }
export const ApprovalResponseSchema = z.object({
  approvalId: z.string().uuid(),
  nonce: z.string().min(32).max(256),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approve', 'deny']),
  gestureToken: z.string().uuid(),
}).strict();
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export type AgentStatus = 'not_configured' | 'starting' | 'ready' | 'running' | 'stopping' | 'error' | 'disconnected';
export type AttachmentStatus = 'none' | 'attached' | 'detached';
export interface Tab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
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
  code: 'TAB_NOT_FOUND' | 'STALE_ELEMENT' | 'INVALID_ARGUMENT' | 'NAVIGATION_FAILED' |
    'UNSUPPORTED_PAGE_STRUCTURE' | 'ACTION_TIMEOUT' | 'PERMISSION_DENIED' |
    'AGENT_DISCONNECTED' | 'APPROVAL_REQUIRED' | 'APPROVAL_DENIED' | 'APPROVAL_STALE' |
    'POLICY_DENIED' | 'UNSUPPORTED_ELEMENT' | 'OPTION_NOT_FOUND' | 'KEY_NOT_ALLOWED' |
    'GRANT_REQUIRED' | 'INVALID_GRANT' | 'STALE_FENCING_TOKEN' | 'PREPARATION_EXPIRED' |
    'DANGEROUS_URL' | 'PRIVATE_NETWORK_BLOCKED' | 'PREPARATION_NOT_FOUND' | 'EXECUTION_TOKEN_USED' |
    'INTERNAL_ERROR';
  message: string;
  retryable: boolean;
  requestId: string;
}
export interface AppState {
  tabs: Tab[];
  activeTabId?: string;
  agents: AgentConfig[];
  agentStatus: AgentStatus;
  attachmentStatus: AttachmentStatus;
  approvals: ApprovalViewState[];
  events: string[];
  error?: string;
  connectedAgentId?: string;
  conversations?: Conversation[];
  activeConversationId?: string;
  bookmarks?: SavedPage[];
  history?: SavedPage[];
  agentModels?: { value: string; name: string }[];
  agentModes?: { value: string; name: string }[];
  agentModel?: string;
  agentMode?: string;
  permissionMode?: PermissionMode;
}

export const IPC = Object.freeze({
  getState: 'app:get-state', state: 'app:state',
  tabOpen: 'tabs:open', tabActivate: 'tabs:activate', tabClose: 'tabs:close',
  tabNavigate: 'tabs:navigate', tabBack: 'tabs:back', tabForward: 'tabs:forward', tabReload: 'tabs:reload',
  agentSave: 'agents:save', agentConnect: 'agents:connect', agentDisconnect: 'agents:disconnect',
  agentAttach: 'agents:attach', agentDetach: 'agents:detach', agentTask: 'agents:task', agentCancel: 'agents:cancel',
  agentRemove: 'agents:remove', viewport: 'browser:viewport',
  conversationNew: 'conversation:new', conversationSelect: 'conversation:select',
  bookmarkToggle: 'bookmark:toggle', historyClear: 'history:clear',
  approvalRequest: 'approval:request', approvalGesture: 'approval:gesture', approvalRespond: 'approval:respond',
  agentSetMode: 'agents:set-mode', agentSetModel: 'agents:set-model',
});
