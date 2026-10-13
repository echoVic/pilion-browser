import type { ToolRequest } from '../../shared/contracts.js';

/**
 * 外部通道的边界：主进程实现这套接口，`external/server.ts` 只负责 socket、认证和审计，
 * 不直接碰 Host / BrowserService，这样将来会话运行时按会话隔离重构时，只动主进程里的实现。
 */

/** 一次已通过认证的外部连接在 Host 里的句柄：跑工具、随连接关闭而收尾。 */
export interface ExternalConnection {
  /** 固化下来的 principal，形如 `external:claude-desktop`。 */
  readonly principal: string;
  readonly client: string;
  readonly connectedAt: string;
  /** Host 里这次连接的 attachment id，审计归因用。 */
  readonly attachmentId: string;
  /** 走完整 Host 治理链路跑一个浏览器工具；throw 即工具失败。 */
  run(request: ToolRequest): Promise<unknown>;
  /** 断开连接时收尾：detach attachment、撤销该 principal 的在途操作（保留它自己的 Tab ACL）。 */
  close(): void;
  /** 用户在设置页显式断开 / 关开关：在 close 之上再摘掉它自己的 Tab ACL entry。 */
  revoke(): void;
}

export interface ExternalRuntime {
  /** 设置里是否开启外部通道；关闭时 socket 即便已连接也会被拒。 */
  isEnabled(): boolean;
  /** 认证通过后接纳一次连接：创建 Host session + attachment + lease，返回句柄。 */
  admit(client: string): ExternalConnection;
  /** 连接生命周期审计（建立 / 认证失败 / 拒绝 / 断开）。 */
  recordEvent(eventType: string, payload: Record<string, unknown>): void;
}

/** 可让外部 Agent（Claude Desktop 等）直接粘进 mcpServers 的配置。 */
export interface ExternalMcpConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  socketPath: string;
  token: string;
}

/** 外部 Agent 允许用的工具子集。见 README / architecture 的理由。 */
export const EXTERNAL_TOOLS = [
  'browser.tabs.list',
  'browser.tabs.open',
  'browser.tabs.activate',
  'browser.tabs.close',
  'browser.navigate',
  'browser.observe',
  'browser.snapshot',
  'browser.screenshot',
  'browser.page_info',
  'browser.click',
  'browser.type',
  'browser.select',
  'browser.check',
  'browser.press',
  'browser.skills.list',
] as const;

/** client 标签只允许这一段字符；principal = `external:<client>`。 */
export function sanitizeClient(client: string | undefined): string {
  const clean = (client ?? 'stdio').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const collapsed = clean.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return collapsed || 'stdio';
}

export function externalPrincipal(client: string): string {
  return `external:${sanitizeClient(client)}`;
}
