import { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  Bookmark,
  Clapperboard,
  Command,
  Copy,
  Download,
  Globe2,
  History,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { AppAction } from '../shared/keybindings';
import { commandOptions, type CommandOption } from './command-options';
import { Dialog, DialogContent, DialogOverlay, DialogTitle, IconButton } from './ui';
import './command-bar.css';

/** 命令图标与侧边栏入口保持一致；AppAction 扩展时缺省回落到通用 ⌘。 */
const ACTION_ICON: Partial<Record<AppAction, LucideIcon>> = {
  newBlankTab: Plus,
  showBookmarks: Bookmark,
  showHistory: History,
  showArchive: Archive,
  showDownloads: Download,
  settings: Settings2,
  copyUrl: Copy,
  togglePanel: PanelRight,
  toggleSidebar: PanelLeft,
  showSkills: Clapperboard,
};

function leadingIcon(option: CommandOption) {
  if (option.kind === 'action') {
    const Icon = ACTION_ICON[option.action] ?? Command;
    return <Icon size={16} />;
  }
  if (option.kind === 'search') return <Search size={16} />;
  if (option.kind === 'page')
    return option.source === 'bookmark' ? <Bookmark size={16} /> : <History size={16} />;
  return <Globe2 size={16} />;
}

type Props = {
  state: AppState;
  open: boolean;
  onOpenChange(open: boolean): void;
  choose(option: CommandOption): void;
};

/** 命令栏：Radix Dialog 提供焦点限制与背景 inert，搜索逻辑保持不变。 */
export function CommandBar({ state, open, onOpenChange, choose }: Props) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const options = commandOptions(state, query);
  const index = Math.min(selection, Math.max(0, options.length - 1));
  const reset = () => {
    setQuery('');
    setSelection(0);
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const handleChoose = (option: CommandOption) => {
    reset();
    choose(option);
  };
  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  useEffect(() => {
    document.getElementById(`command-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogOverlay className="command-overlay" />
      <DialogContent
        className="command-dialog"
        aria-label="命令栏"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // FocusScope 的焦点恢复是异步（setTimeout 0），由 main.tsx 的 useLayoutEffect 统一处理。
          event.preventDefault();
        }}
        onEscapeKeyDown={close}
        onPointerDownOutside={close}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle className="visually-hidden">命令栏</DialogTitle>
        <div className="command-input-row">
          <Search size={18} />
          <input
            ref={input}
            role="combobox"
            aria-label="搜索标签、网址或命令"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-activedescendant={options[index] ? `command-option-${index}` : undefined}
            placeholder="搜索标签、网址或命令"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelection(0);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const offset = event.key === 'ArrowDown' ? 1 : -1;
                setSelection((index + offset + options.length) % Math.max(1, options.length));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (options[index]) handleChoose(options[index]);
              }
            }}
          />
          <IconButton label="关闭命令栏" onClick={close}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="command-results" id="command-results" role="listbox" aria-label="搜索结果">
          {options.map((option, position) => (
            <button
              key={option.id}
              id={`command-option-${position}`}
              role="option"
              aria-selected={position === index}
              tabIndex={-1}
              onPointerMove={() => setSelection(position)}
              onClick={() => handleChoose(option)}
            >
              {leadingIcon(option)}
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              {/* ↗ 只表示“真的打开/跳走”：切换到已开标签或应用内操作不显示，避免外链误导。 */}
              {(option.kind === 'page' || option.kind === 'search') && (
                <ArrowUpRight size={14} className="command-go" />
              )}
            </button>
          ))}
          {!options.length && (
            <div className="command-empty">
              <Search size={20} />
              <strong>没有匹配的命令</strong>
              <small>
                试试「书签」或「归档」，按 <kbd>Esc</kbd> 关闭
              </small>
            </div>
          )}
        </div>
        <footer className="command-footer">
          <span className="command-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <em>选择</em>
            <i aria-hidden>·</i>
            <kbd>Enter</kbd>
            <em>打开</em>
            <i aria-hidden>·</i>
            <kbd>Esc</kbd>
            <em>关闭</em>
          </span>
          <span className="command-hint">
            输入 <kbd>{'>'}</kbd> 只搜索命令
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
