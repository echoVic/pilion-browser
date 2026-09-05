import { z } from 'zod';
export const AgentConfigSchema=z.object({id:z.string().min(1),name:z.string().min(1),command:z.string().min(1),args:z.array(z.string()).default([]),cwd:z.string().optional(),env:z.record(z.string(),z.string()).optional(),enabled:z.boolean().default(true)});
export type AgentConfig=z.infer<typeof AgentConfigSchema>;
export type AgentStatus='not_configured'|'starting'|'connecting'|'ready'|'running'|'stopping'|'error'|'disconnected';
export interface Tab {id:string;title:string;url:string;loading:boolean;canGoBack:boolean;canGoForward:boolean;crashed:boolean}
export type ToolName='browser.page_info'|'browser.navigate'|'browser.tabs.list'|'browser.tabs.open'|'browser.tabs.activate'|'browser.tabs.close'|'browser.observe'|'browser.click'|'browser.type';
export interface ToolRequest {requestId:string;name:ToolName;args:Record<string,unknown>;timeoutMs?:number}
export interface ToolError {code:'TAB_NOT_FOUND'|'STALE_ELEMENT'|'INVALID_ARGUMENT'|'NAVIGATION_FAILED'|'UNSUPPORTED_PAGE_STRUCTURE'|'ACTION_TIMEOUT'|'PERMISSION_DENIED'|'AGENT_DISCONNECTED'|'INTERNAL_ERROR';message:string;retryable:boolean;requestId:string}
export interface AppState {tabs:Tab[];activeTabId?:string;agents:AgentConfig[];agentStatus:AgentStatus;events:string[];error?:string}
