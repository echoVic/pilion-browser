import { useEffect, useMemo, useState } from 'react';
import { Globe2, Hand, LayoutGrid, PlayCircle, ShieldAlert, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import {
  activityLabel,
  STATUS_TEXT,
  taskOverviewModel,
  type TaskCard,
  type TaskCardStatus,
} from './task-overview';
import { Dialog, DialogContent, DialogOverlay, DialogTitle, IconButton } from './ui';
import './task-overview.css';

type Props = {
  state: AppState;
  open: boolean;
  onOpenChange(open: boolean): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/** 状态色只借用现成的语义：确认用杏色、接管用琥珀、运行用品牌绿、可恢复用中性。 */
const STATUS_ICON = {
  confirm: ShieldAlert,
  running: PlayCircle,
  held: Hand,
  recoverable: LayoutGrid,
} satisfies Record<TaskCardStatus, typeof LayoutGrid>;

type Act = (action: () => Promise<unknown>) => void;

function TaskCardView({ card, now, act }: { card: TaskCard; now: number; act: Act }) {
  const Icon = STATUS_ICON[card.status];
  const statusText = STATUS_TEXT[card.status];
  return (
    <article
      className="task-card"
      data-status={card.status}
      role="listitem"
      aria-label={`${card.label}：${statusText}`}
    >
      <header className="task-card-head">
        <span className="task-status">
          <Icon size={12} aria-hidden="true" />
          {statusText}
        </span>
        <span className="task-client">{card.clientName}</span>
      </header>
      <div className="task-card-title-row">
        <span className="space-dot" data-color={card.color} aria-hidden="true" />
        <h3 className="task-card-title" title={card.label}>
          {card.label}
        </h3>
      </div>
      {card.pageTitle ? (
        <div className="task-card-page" title={card.pageTitle}>
          <Globe2 size={13} aria-hidden="true" />
          <span className="task-page-title">{card.pageTitle}</span>
          {card.pageHost && <span className="task-page-host">{card.pageHost}</span>}
        </div>
      ) : (
        <div className="task-card-page is-empty">
          <Globe2 size={13} aria-hidden="true" />
          <span>还没有标签</span>
        </div>
      )}
      <div className="task-card-meta">
        <span>{card.tabCount} 个标签</span>
        <span aria-hidden="true">·</span>
        <span>{activityLabel(card.lastActiveAt, now)}</span>
        {card.live && card.status === 'running' && (
          <i className="task-live" aria-label="Agent 正在操作" />
        )}
      </div>
      <div className="task-card-actions">
        <button
          type="button"
          className="task-action"
          onClick={() => act(() => window.pilion.spaces.select(card.spaceId))}
        >
          查看
        </button>
        {card.status === 'running' || card.status === 'confirm' ? (
          <>
            <button
              type="button"
              className="task-action"
              onClick={() => act(() => window.pilion.spaces.takeOverAgent(card.spaceId))}
            >
              接管
            </button>
            <button
              type="button"
              className="task-action is-danger"
              onClick={() => act(() => window.pilion.spaces.stopAgent(card.spaceId))}
            >
              停止
            </button>
          </>
        ) : card.status === 'held' ? (
          <button
            type="button"
            className="task-action is-primary"
            onClick={() => act(() => window.pilion.spaces.handBackAgent(card.spaceId))}
          >
            交还
          </button>
        ) : (
          <button
            type="button"
            className="task-action is-primary"
            onClick={() => act(() => window.pilion.spaces.takeOverAgent(card.spaceId))}
          >
            再次接管
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * 任务总览：瞬时浮层，不是页面。卡片对象是「Agent 任务」（外部 Agent Space），
 * 人自己的空间不在这里——侧栏已经是它们的常驻入口。
 */
export function TaskOverview({ state, open, onOpenChange, run }: Props) {
  const model = useMemo(() => taskOverviewModel(state), [state]);
  // 相对时间（「3 分钟前有活动」）只在打开/状态变化时刷新，渲染期不读时钟。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    // 回调里刷新时钟，避免在 effect 里同步 setState（也会让「N 分钟前」跟着重新打开更新）。
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, [open, state]);
  const act: Act = (action) => {
    onOpenChange(false);
    void run(action);
  };
  const close = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay className="task-overview-overlay" />
      <DialogContent
        className="task-overview-dialog"
        aria-label="任务总览"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // 打开时别把焦点环落在右上角关闭按钮上；先聚焦对话框本体，Tab 再进卡片。
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          content?.focus();
        }}
        onEscapeKeyDown={close}
        onPointerDownOutside={close}
      >
        <DialogTitle className="visually-hidden">任务总览</DialogTitle>
        <header className="task-overview-header">
          <div className="task-overview-heading">
            <h2>任务总览</h2>
            <p>Agent 正在进行的任务和等你接手的空间。人自己的标签仍在侧栏。</p>
          </div>
          <div className="task-overview-tools">
            <span className="task-overview-count">{model.cards.length} 个任务</span>
            <IconButton label="关闭任务总览" onClick={close}>
              <X size={15} />
            </IconButton>
          </div>
        </header>
        {model.cards.length === 0 ? (
          <div className="task-overview-empty">
            <span className="task-overview-empty-icon">
              <LayoutGrid size={22} aria-hidden="true" />
            </span>
            <strong>目前没有进行中的 Agent 任务</strong>
            <span>让 Agent 开一个任务后，它的空间、状态和快捷操作会出现在这里。</span>
          </div>
        ) : (
          <div className="task-overview-grid" role="list">
            {model.cards.map((card) => (
              <TaskCardView key={card.spaceId} card={card} now={now} act={act} />
            ))}
          </div>
        )}
        <footer className="task-overview-footer">
          <span>
            {model.endedCount > 0
              ? `另有 ${model.endedCount} 个已结束的 Agent 空间，可在侧栏查看或删除。`
              : '等待确认的任务排在最前面；接管和交还都会保留页面的当前状态。'}
          </span>
          <span className="task-overview-hint">Esc 关闭</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
