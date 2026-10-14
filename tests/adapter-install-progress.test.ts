import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdapterInstallState, AppState } from '../src/shared/contracts';
import { AdapterInstallProgress } from '../src/renderer/AdapterInstallProgress';
import { LocalAgentSettings } from '../src/renderer/LocalAgentSettings';
import { ConversationPanel } from '../src/renderer/ConversationPanel';

const install: AdapterInstallState = {
  presetId: 'claude',
  name: 'Claude Code',
  package: '@agentclientprotocol/claude-agent-acp@0.89.1',
  startedAt: 10_000,
  downloadedBytes: 23_400_000,
};
const state: AppState = {
  tabs: [],
  agents: [],
  agentStatus: 'starting',
  attachmentStatus: 'none',
  approvals: [],
  pendingApprovalsByConversation: {},
  events: [],
  adapterInstall: install,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps ticking progress outside its stable live announcement', () => {
  vi.useFakeTimers();
  vi.setSystemTime(75_000);
  const first = renderToStaticMarkup(createElement(AdapterInstallProgress, { install }));
  vi.setSystemTime(76_000);
  const next = renderToStaticMarkup(
    createElement(AdapterInstallProgress, { install: { ...install, downloadedBytes: 24_500_000 } }),
  );
  const live = (html: string) => html.match(/<span\b[^>]*role="status"[^>]*>(.*?)<\/span>/)?.[1];
  expect(first).toContain('正在下载 ACP 适配器 · 已下载 23.4 MB · 1:05');
  expect(next).toContain('正在下载 ACP 适配器 · 已下载 24.5 MB · 1:06');
  expect(live(first)).toBe('正在安装 Claude Code 的 ACP 适配器');
  expect(live(next)).toBe(live(first));
  expect(next).toMatch(/class="visually-hidden"[^>]*role="status"/);
  expect(next).not.toMatch(/role="status"[^>]*>[^<]*已下载/);
});

it('stays silent before the first install and preserves ordinary connecting text', () => {
  const html = renderToStaticMarkup(
    createElement(AdapterInstallProgress, { fallback: '正在连接 Agent…' }),
  );
  expect(html).toContain('正在连接 Agent…');
  expect(html).not.toContain('安装已结束');
  expect(html).not.toContain('正在下载 ACP');
});

it('shows settings progress only for the preset that is installing', () => {
  vi.useFakeTimers();
  vi.setSystemTime(75_000);
  vi.stubGlobal('window', {});
  const render = (preset: 'claude' | 'codex') =>
    renderToStaticMarkup(
      createElement(LocalAgentSettings, { state, initialPreset: preset, run: async () => true }),
    );
  expect(render('claude')).toContain('正在下载 ACP 适配器 · 已下载 23.4 MB · 1:05');
  expect(render('codex')).not.toContain('正在下载 ACP 适配器');
  expect(render('claude')).toMatch(/<\/footer>[\s\S]*正在下载 ACP 适配器/);
});

it('uses installation progress for the Agent panel connecting status', () => {
  vi.useFakeTimers();
  vi.setSystemTime(75_000);
  vi.stubGlobal('window', {});
  const html = renderToStaticMarkup(
    createElement(ConversationPanel, {
      state,
      settings() {},
      close() {},
      run: async () => true,
      draft: '',
      setDraft() {},
    }),
  );
  expect(html).toContain('正在下载 ACP 适配器 · 已下载 23.4 MB · 1:05');
  expect(html).not.toContain('正在连接 Agent…');
  expect(html).toMatch(/class="agent-selector[^"]*is-installing/);
});
