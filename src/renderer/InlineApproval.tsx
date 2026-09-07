import { useState } from 'react';
import { ShieldCheck, X, Check, ChevronDown } from 'lucide-react';
import type { ApprovalViewState } from '../shared/contracts';

export function InlineApproval({
  approval,
  count,
  run,
}: {
  approval: ApprovalViewState;
  count: number;
  run(action: () => Promise<unknown>): Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState(false);
  async function decide(decision: 'approve' | 'deny') {
    if (submitting || !approval.nonce || !approval.actionDigest) return;
    setSubmitting(true);
    try {
      await run(() =>
        window.pilion.agents.approve(
          approval.approvalId,
          approval.nonce!,
          approval.actionDigest!,
          decision,
        ),
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="inline-approval" aria-label="操作审批">
      <header>
        <ShieldCheck size={16} />
        <strong>需要确认操作</strong>
        {count > 1 && <span>{count} 项待确认</span>}
      </header>
      <p className="approval-tool">{approval.tool}</p>
      <details>
        <summary>
          操作详情
          <ChevronDown size={13} />
        </summary>
        <pre>{approval.summary}</pre>
      </details>
      <footer>
        <button
          disabled={submitting}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void decide('deny');
          }}
        >
          <X size={14} />
          拒绝
        </button>
        <button
          className="approve-inline"
          disabled={submitting}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void decide('approve');
          }}
        >
          <Check size={14} />
          批准一次
        </button>
      </footer>
    </section>
  );
}
