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
  // 缺了校验信息的审批主进程不会接受；按钮点了也没反应，不如直接说清楚处理不了。
  const decidable = Boolean(approval.nonce && approval.actionDigest);
  const locked = submitting || !decidable;
  const headTitle = approval.externalClientName
    ? `外部客户端：${approval.externalClientName}`
    : '需要确认操作';
  async function decide(decision: 'approve' | 'deny', scope?: 'space' | 'client') {
    if (submitting || !approval.nonce || !approval.actionDigest) return;
    setSubmitting(true);
    try {
      await run(() =>
        window.pilion.agents.approve(
          approval.approvalId,
          approval.nonce!,
          approval.actionDigest!,
          decision,
          scope,
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
          <strong title={headTitle}>{headTitle}</strong>
          {count > 1 && <span className="appr-count">{count} 项待确认</span>}
        </div>
        <p className="appr-tool" title={approval.tool}>
          {approval.tool}
        </p>
        <details className="appr-details">
          <summary>
            操作详情
            <ChevronRight size={12} className="chev-sm" />
          </summary>
          <pre tabIndex={0}>{approval.summary}</pre>
        </details>
        {decidable ? null : (
          <p className="appr-scope-hint" role="status">
            这条审批缺少校验信息，暂时无法在这里处理；请停止任务后重试。
          </p>
        )}
        <div className="appr-actions">
          <button
            className="btn btn-danger-ghost"
            disabled={locked}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) void decide('deny');
            }}
          >
            <X size={14} />
            拒绝
          </button>
          {approval.allowedScopes?.includes('space') ? (
            <button
              className="btn btn-primary"
              disabled={locked}
              title="允许此任务 Space 的后续浏览器操作；任务结束或被接管后失效"
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void decide('approve', 'space');
              }}
            >
              <Check size={14} />
              本任务允许
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={locked}
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void decide('approve');
              }}
            >
              <Check size={14} />
              批准一次
            </button>
          )}
        </div>
        {approval.allowedScopes?.length ? (
          <>
            <div className="appr-scope-actions">
              {approval.allowedScopes.includes('space') && (
                <button
                  className="btn btn-ghost"
                  disabled={locked}
                  onClick={(event) => {
                    if (event.nativeEvent.isTrusted) void decide('approve');
                  }}
                >
                  批准一次
                </button>
              )}
              {approval.allowedScopes.includes('client') && (
                <button
                  className="btn btn-ghost"
                  disabled={locked}
                  title="允许此客户端今后的浏览器操作，重启后仍生效；可在设置中撤回"
                  onClick={(event) => {
                    if (event.nativeEvent.isTrusted) void decide('approve', 'client');
                  }}
                >
                  始终允许此客户端
                </button>
              )}
            </div>
            <p className="appr-scope-hint">
              {approval.allowedScopes.includes('space') ? '本任务随 Space 结束失效；' : ''}
              始终允许可在「设置 › Agent 连接」中撤回。
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
