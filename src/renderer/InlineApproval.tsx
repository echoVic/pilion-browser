import { useState } from 'react';
import { ShieldCheck, X, Check, ChevronRight } from 'lucide-react';
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
    <section
      className="approval-dock"
      aria-label={approval.externalClientName ? '外部客户端操作审批' : '操作审批'}
    >
      <div className="approval-card">
        <div className="appr-head">
          <ShieldCheck size={15} />
          <strong>
            {approval.externalClientName
              ? `外部客户端：${approval.externalClientName}`
              : '需要确认操作'}
          </strong>
          {count > 1 && <span className="appr-count">{count} 项待确认</span>}
        </div>
        <p className="appr-tool">{approval.tool}</p>
        <details className="appr-details">
          <summary>
            操作详情
            <ChevronRight size={12} className="chev-sm" />
          </summary>
          <pre>{approval.summary}</pre>
        </details>
        <div className="appr-actions">
          <button
            className="btn btn-danger-ghost"
            disabled={submitting}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) void decide('deny');
            }}
          >
            <X size={14} />
            拒绝
          </button>
          <button
            className="btn btn-primary"
            disabled={submitting}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) void decide('approve');
            }}
          >
            <Check size={14} />
            批准一次
          </button>
        </div>
      </div>
    </section>
  );
}
