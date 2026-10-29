import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Command, Globe2, Search, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import { commandOptions, type CommandOption } from './command-options';
import { Dialog, DialogContent, DialogOverlay, DialogTitle, IconButton } from './ui';
import './command-bar.css';

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
              {option.kind === 'action' ? (
                <Command size={16} />
              ) : option.kind === 'search' ? (
                <Search size={16} />
              ) : (
                <Globe2 size={16} />
              )}
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
          {!options.length && <p className="command-empty">没有匹配的命令，试试“书签”或“归档”。</p>}
        </div>
        <footer className="command-footer">
          <span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span>输入 &gt; 只搜索命令</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
