import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import {
  DEFAULT_SPACE,
  SPACE_COLORS,
  isAgentSpace,
  type SpaceColor,
} from '../shared/tab-organization';
import { IconButton } from './ui';
import { AgentSpaceGroup } from './AgentSpaceGroup';

const colorLabels: Record<SpaceColor, string> = {
  neutral: '中性',
  teal: '青绿',
  blue: '蓝色',
  purple: '紫色',
  rose: '玫瑰',
  amber: '琥珀',
};
type Props = { state: AppState; run(action: () => Promise<unknown>): Promise<boolean> };

export function SpaceSwitcher({ state, run }: Props) {
  const spaces = state.spaces ?? [DEFAULT_SPACE];
  const current = spaces.find((space) => space.id === state.activeSpaceId) ?? spaces[0];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<'create' | 'edit' | null>(null);
  /** 等二次确认的人建空间 id；入口就在行上，确认条也只占这一行，避免误删。 */
  const [removing, setRemoving] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<SpaceColor>('teal');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const removeConfirm = useRef<HTMLDivElement>(null);
  // 列表可滚动：靠底部的行展开确认条时要把它滚进视野，否则入口点了像没反应。
  useEffect(() => {
    if (removing) removeConfirm.current?.scrollIntoView?.({ block: 'nearest' });
  }, [removing]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 确认条还开着时，第一次 Escape 只撤销它，再按一次才收起整个菜单。
      if (removing) {
        setRemoving(null);
        // 焦点可能停在确认条按钮上、随它一起卸载，撤销后还给触发它的行内垃圾桶。
        requestAnimationFrame(() => removeButtons.current.get(removing)?.focus());
        return;
      }
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, removing]);
  const edit = (mode: 'create' | 'edit') => {
    setRemoving(null);
    setName(mode === 'edit' ? current.name : '');
    setColor(mode === 'edit' ? current.color : 'teal');
    setEditing(mode);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const cancelRemove = (spaceId: string) => {
    setRemoving(null);
    // 确认条收起后把焦点还给触发它的垃圾桶，键盘操作不会掉到 body 上。
    requestAnimationFrame(() => removeButtons.current.get(spaceId)?.focus());
  };
  const remove = async (spaceId: string) => {
    setBusy(true);
    try {
      if (await run(() => window.pilion.spaces.remove(spaceId))) {
        setRemoving(null);
        close();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-switcher" ref={root}>
      <button
        className="space-trigger"
        ref={trigger}
        aria-label={`切换空间：${current.name}`}
        aria-expanded={open}
        onClick={() => {
          setEditing(null);
          setRemoving(null);
          setOpen(!open);
        }}
      >
        <span className="space-dot" data-color={current.color} aria-hidden="true" />
        <strong>{current.name}</strong>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="space-popover">
          {editing ? (
            <form
              className="space-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!name.trim() || busy) return;
                setBusy(true);
                try {
                  const success = await run(() =>
                    editing === 'create'
                      ? window.pilion.spaces.create(name.trim(), color)
                      : window.pilion.spaces.edit(current.id, name.trim(), color),
                  );
                  if (success) close();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="space-form-header">
                <strong>{editing === 'create' ? '新建空间' : '编辑空间'}</strong>
                <IconButton label="关闭空间编辑" type="button" onClick={() => setEditing(null)}>
                  <X size={13} />
                </IconButton>
              </div>
              <input
                autoFocus
                aria-label="空间名称"
                value={name}
                maxLength={40}
                required
                placeholder="例如：工作、阅读"
                onChange={(event) => setName(event.target.value)}
              />
              <div className="space-colors" role="group" aria-label="空间颜色">
                {SPACE_COLORS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={colorLabels[value]}
                    aria-pressed={value === color}
                    data-color={value}
                    onClick={() => setColor(value)}
                  >
                    {value === color && <Check size={12} />}
                  </button>
                ))}
              </div>
              <button type="submit" className="space-submit" disabled={busy || !name.trim()}>
                {busy ? '保存中…' : editing === 'create' ? '创建空间' : '保存空间'}
              </button>
            </form>
          ) : (
            <>
              <div className="space-list" role="group" aria-label="空间列表">
                {spaces.map((space) => {
                  const isCurrent = space.id === current.id;
                  // 只给人建空间行内入口；Agent 空间由下方分组管理。且始终留一个其它人建空间，
                  // 否则删除后标签会被迁进 Agent 空间，Agent 空间清理时再被连带归档。
                  const removable =
                    !isAgentSpace(space) &&
                    spaces.some((other) => other.id !== space.id && !isAgentSpace(other));
                  const confirmId = `space-remove-confirm-${space.id}`;
                  return (
                    <Fragment key={space.id}>
                      <div className={`space-row${isCurrent ? ' is-current' : ''}`}>
                        <button
                          className="space-row-select"
                          aria-pressed={isCurrent}
                          onClick={async () => {
                            if (await run(() => window.pilion.spaces.select(space.id))) close();
                          }}
                        >
                          <span className="space-dot" data-color={space.color} />
                          <span className="space-row-name">{space.name}</span>
                          {state.agentTabs?.some(
                            (entry) =>
                              entry.running &&
                              state.tabs.some(
                                (tab) => tab.id === entry.tabId && tab.spaceId === space.id,
                              ),
                          ) && (
                            <span
                              className="space-agent-activity"
                              title="Agent 在此空间运行"
                              aria-label="Agent 在此空间运行"
                            />
                          )}
                          {isCurrent && <Check size={13} />}
                        </button>
                        {removable && (
                          <button
                            type="button"
                            className="space-row-remove"
                            ref={(node) => {
                              if (node) removeButtons.current.set(space.id, node);
                              else removeButtons.current.delete(space.id);
                            }}
                            aria-label={`删除空间：${space.name}`}
                            aria-expanded={removing === space.id}
                            aria-controls={removing === space.id ? confirmId : undefined}
                            title="删除空间（保留标签）"
                            disabled={busy}
                            onClick={() => setRemoving(space.id)}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      {removing === space.id && (
                        <div className="space-remove-confirm" id={confirmId} ref={removeConfirm}>
                          <span className="space-remove-copy" role="alert">
                            删除「{space.name}」？
                            <span className="space-remove-note">其中的标签会保留</span>
                          </span>
                          <span className="space-remove-actions">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => cancelRemove(space.id)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="space-remove-delete"
                              disabled={busy}
                              onClick={() => void remove(space.id)}
                            >
                              {busy ? '删除中…' : '删除空间'}
                            </button>
                          </span>
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
              <AgentSpaceGroup
                spaces={spaces}
                agentClientNames={state.agentClientNames}
                activeSpaceId={state.activeSpaceId}
                run={run}
              />
              <button className="space-menu-action" onClick={() => edit('create')}>
                <Plus size={14} />
                新建空间
              </button>
              <button
                className="space-menu-action"
                onClick={() => edit('edit')}
                disabled={isAgentSpace(current)}
                title={isAgentSpace(current) ? 'Agent 空间无法编辑' : undefined}
              >
                <Pencil size={14} />
                编辑当前空间
              </button>
              <small>各空间共享网站登录状态</small>
            </>
          )}
        </div>
      )}
    </div>
  );
}
