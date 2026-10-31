import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import { DEFAULT_SPACE, SPACE_COLORS, type SpaceColor } from '../shared/tab-organization';
import { IconButton } from './ui';

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
  const [name, setName] = useState('');
  const [color, setColor] = useState<SpaceColor>('teal');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const edit = (mode: 'create' | 'edit') => {
    setName(mode === 'edit' ? current.name : '');
    setColor(mode === 'edit' ? current.color : 'teal');
    setEditing(mode);
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
                  if (success) {
                    setOpen(false);
                    trigger.current?.focus();
                  }
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
              <button
                type="submit"
                className="space-submit"
                disabled={busy || !name.trim()}
              >
                {busy ? '保存中…' : editing === 'create' ? '创建空间' : '保存空间'}
              </button>
              {editing === 'edit' && spaces.length > 1 && (
                <button
                  className="space-remove"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => window.pilion.spaces.remove(current.id))) {
                      setOpen(false);
                      trigger.current?.focus();
                    }
                  }}
                >
                  删除空间，保留标签
                </button>
              )}
            </form>
          ) : (
            <>
              <div className="space-list" role="group" aria-label="空间列表">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    aria-pressed={space.id === current.id}
                    onClick={async () => {
                      if (await run(() => window.pilion.spaces.select(space.id))) {
                        setOpen(false);
                        trigger.current?.focus();
                      }
                    }}
                  >
                    <span className="space-dot" data-color={space.color} />
                    <span>{space.name}</span>
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
                    {space.id === current.id && <Check size={13} />}
                  </button>
                ))}
              </div>
              <button className="space-menu-action" onClick={() => edit('create')}>
                <Plus size={14} />
                新建空间
              </button>
              <button className="space-menu-action" onClick={() => edit('edit')}>
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
