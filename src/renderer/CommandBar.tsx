import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Command, Globe2, Search, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import { commandOptions, type CommandOption } from './command-options';
import { IconButton } from './ui';
import './command-bar.css';

type Props = { state: AppState; close(): void; choose(option: CommandOption): void };

/** 原生网页由 App 在显示命令栏时隐藏，dialog 提供焦点限制与背景 inert。 */
export function CommandBar({ state, close, choose }: Props) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const options = commandOptions(state, query);
  const index = Math.min(selection, Math.max(0, options.length - 1));
  useLayoutEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`command-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <dialog
      className="command-dialog"
      ref={dialog}
      aria-label="命令栏"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
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
              if (options[index]) choose(options[index]);
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
            onClick={() => choose(option)}
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
    </dialog>
  );
}
