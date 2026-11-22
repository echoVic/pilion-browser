import { useEffect, useRef, useState } from 'react';
import { X, Check, ChevronDown, ChevronRight } from 'lucide-react';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  // 缺了校验信息的审批主进程不会接受；按钮点了也没反应，不如直接说清楚处理不了。
  const decidable = Boolean(approval.nonce && approval.actionDigest);
  const locked = submitting || !decidable;
  const hasScopes = Boolean(approval.allowedScopes?.length);
  const preferSpace = Boolean(approval.allowedScopes?.includes('space'));
  const headTitle = approval.externalClientName
    ? `外部客户端：${approval.externalClientName}`
    : '需要确认操作';

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (splitRef.current && !splitRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menuOpen]);

  async function decide(decision: 'approve' | 'deny', scope?: 'space' | 'client') {
    if (submitting || !approval.nonce || !approval.actionDigest) return;
    setMenuOpen(false);
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
          <span className="appr-dot" aria-hidden="true" />
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
            type="button"
            className="btn btn-danger-ghost"
            disabled={locked}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) void decide('deny');
            }}
          >
            <X size={14} />
            拒绝
          </button>
          {hasScopes ? (
            <div className="appr-split" ref={splitRef}>
              <button
                type="button"
                className="btn btn-primary appr-split-main"
                disabled={locked}
                title={
                  preferSpace
                    ? '允许此任务 Space 的后续浏览器操作；任务结束或被接管后失效'
                    : undefined
                }
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted)
                    void decide('approve', preferSpace ? 'space' : undefined);
                }}
              >
                <Check size={14} />
                {preferSpace ? '本任务允许' : '批准一次'}
              </button>
              <button
                type="button"
                className="btn btn-primary appr-split-caret"
                aria-label="更多授权选项"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={locked}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <ChevronDown size={13} />
              </button>
              <div className="appr-split-menu" role="menu" hidden={!menuOpen}>
                {preferSpace && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={locked}
                    onClick={(event) => {
                      if (event.nativeEvent.isTrusted) void decide('approve');
                    }}
                  >
                    <strong>批准一次</strong>
                    <small>仅放行当前这一步操作</small>
                  </button>
                )}
                {approval.allowedScopes?.includes('client') && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={locked}
                    title="允许此客户端今后的浏览器操作，重启后仍生效；可在设置中撤回"
                    onClick={(event) => {
                      if (event.nativeEvent.isTrusted) void decide('approve', 'client');
                    }}
                  >
                    <strong>始终允许此客户端</strong>
                    <small>重启后仍生效，可在设置中撤回</small>
                  </button>
                )}
                <p className="appr-scope-hint">
                  {preferSpace ? '本任务随 Space 结束失效；' : ''}
                  始终允许可在「设置 › Agent 连接」中撤回。
                </p>
              </div>
            </div>
          ) : (
            <button
              type="button"
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
      </div>
    </section>
  );
}
