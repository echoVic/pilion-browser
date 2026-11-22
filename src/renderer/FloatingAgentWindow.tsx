import { useCallback, useEffect, useState } from 'react';
import type { AppState } from '../shared/contracts';
import type { LocalAgentPreset } from '../shared/local-agents';
import { ConversationPanel } from './ConversationPanel';
import { ComposerStore } from './composer/composer-store';
import { TaskOverview } from './TaskOverview';
import { applyTheme, cachedTheme } from './ui';

const empty: AppState = {
  tabs: [],
  agents: [],
  agentStatus: 'not_configured',
  attachmentStatus: 'detached',
  approvals: [],
  pendingApprovalsByConversation: {},
  conversationAgents: {},
  events: [],
};

export function FloatingAgentWindow() {
  const [state, setState] = useState<AppState>(empty);
  const [composerStore] = useState(() => new ComposerStore());
  const [overviewOpen, setOverviewOpen] = useState(false);

  useEffect(() => {
    document.title = 'Pilion Agent';
    document.documentElement.classList.add('floating-agent-root');
    applyTheme(cachedTheme());
    return () => {
      document.documentElement.classList.remove('floating-agent-root');
    };
  }, []);

  useEffect(() => {
    if (state.settings?.theme) applyTheme(state.settings.theme);
  }, [state.settings?.theme]);

  useEffect(() => {
    if (!window.pilion) return;
    let received = false;
    const off = window.pilion.onState((next) => {
      received = true;
      setState(next);
    });
    void window.pilion
      .getState()
      .then((next) => {
        if (!received) setState(next);
      })
      .catch(() => undefined);
    return off;
  }, []);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch {
      return false;
    }
  }, []);

  const manageAgents = (preset?: LocalAgentPreset) =>
    void run(() => window.pilion.settings.open({ pane: 'agent', preset, returnOnConnect: true }));

  return (
    <div className="floating-agent-shell">
      <ConversationPanel
        state={state}
        floating
        settings={manageAgents}
        toggleFloat={() => void run(() => window.pilion.workspace.dockAgentPanel())}
        close={() => void run(() => window.pilion.workspace.closeAgentFloat())}
        run={run}
        composer={composerStore}
        openTaskOverview={() => setOverviewOpen(true)}
      />
      <TaskOverview state={state} open={overviewOpen} onOpenChange={setOverviewOpen} run={run} />
    </div>
  );
}
