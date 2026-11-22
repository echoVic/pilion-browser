import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ThreadComposerRuntime } from '@assistant-ui/react';
import { AtSign, Globe2, ImagePlus, Plus, SearchX, Slash, X, Zap } from 'lucide-react';
import type { AppState, PromptAttachment, RecordingSummary } from '../shared/contracts.js';
import { MAX_IMAGES_PER_PROMPT } from '../shared/contracts.js';
import { addImageAttachments } from './composer/attachments.js';
import { filterSkills, skillInsertText, type SkillOption } from './composer/skill-picker.js';

type BrowserTab = AppState['tabs'][number];

type Props = {
  runtime: ThreadComposerRuntime;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  /** Agent 是否正在跑：Enter 在运行时改为排队，而不是触发被禁用的发送。 */
  busy: boolean;
  /** 打断或提交在途：Enter 与 ⌘/Ctrl+Enter 都不再发起，免得同一段输入发两次。 */
  locked: boolean;
  /** Agent 公布了 promptCapabilities.image。false 时禁掉图片并提示。 */
  imageCapable: boolean;
  skills: readonly RecordingSummary[];
  /** 当前空间打开的标签页，用于 @ 快速引用。 */
  tabs?: readonly BrowserTab[];
  /** 内嵌于输入框顶部的上下文胶囊（如当前标签页与共享状态）。 */
  contextStrip?: ReactNode;
  /** 内嵌于底部工具栏左侧的控件（Agent / 模型 / 权限）。 */
  footerLeft?: ReactNode;
  /** 内嵌于底部工具栏最右侧的主操作键（发送 / 停止 / 连接）。 */
  footerRight?: ReactNode;
  attachments: readonly PromptAttachment[];
  setAttachments(attachments: readonly PromptAttachment[]): void;
  onNotice(message: string): void;
  /** 运行中按 Enter：把当前输入排队。 */
  onEnqueue(text: string, attachments: readonly PromptAttachment[]): void;
  /** Cmd/Ctrl+Enter：先打断当前回合，收尾后立即发送当前输入与队列（由面板读取输入框与队列）。 */
  onInterruptAndSend(): Promise<void>;
};

function tabDisplayHost(url: string, title: string): string {
  if (!url || url === 'about:blank') return title || '新标签页';
  try {
    return new URL(url).hostname.replace(/^www\./, '') || title || url;
  } catch {
    return title || url;
  }
}

export function ComposerInput({
  runtime,
  inputRef,
  placeholder,
  busy,
  locked,
  imageCapable,
  skills,
  tabs = [],
  contextStrip,
  footerLeft,
  footerRight,
  attachments,
  setAttachments,
  onNotice,
  onEnqueue,
  onInterruptAndSend,
}: Props) {
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(-1);
  const [tabPickerDismissed, setTabPickerDismissed] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    if (!plusOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlusOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(event.target as Node)) setPlusOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [plusOpen]);

  useEffect(() => {
    const sync = () => {
      const input = inputRef.current;
      const text = runtime.getState().text;
      if (input && !composing.current && input.value !== text) input.value = text;
    };
    sync();
    return runtime.subscribe(sync);
  }, [runtime, inputRef]);

  // 自己订阅输入框文字：面板不随每次按键重渲染，「/」与「@」选择器仍要跟着输入实时展开。
  const subscribeText = useCallback(
    (listener: () => void) => runtime.subscribe(listener),
    [runtime],
  );
  const readText = () => runtime.getState().text;
  const text = useSyncExternalStore(subscribeText, readText, readText);
  // 「/」选择器：输入以 / 开头、且还没有空格时展开。查询就是 / 后面的部分。
  const pickerQuery = /^\/(\S*)$/.test(text) ? text.slice(1) : null;
  const options: SkillOption[] = pickerQuery === null ? [] : filterSkills(skills, pickerQuery);
  const skillCount = filterSkills(skills, '').length;
  const shownSkillPicker = pickerQuery !== null && (options.length > 0 || pickerQuery.length > 0);

  // 「@」标签页选择器：行尾出现独立的 @query 时展开，支持键盘上下选择并插入。
  const atMatch = shownSkillPicker ? null : /(?:^|\s)@([^\s@]*)$/.exec(text);
  const atQuery = atMatch ? atMatch[1].toLowerCase() : null;
  const tabOptions =
    atQuery === null
      ? []
      : tabs.filter((tab) => {
          if (!tab.url || tab.url === 'about:blank') return atQuery === '';
          const haystack = `${tab.title} ${tab.url}`.toLowerCase();
          return haystack.includes(atQuery);
        });
  const shownTabPicker = atQuery !== null && !tabPickerDismissed && tabOptions.length > 0;
  const activePickerCount = shownSkillPicker
    ? options.length
    : shownTabPicker
      ? tabOptions.length
      : 0;

  async function acceptFiles(list: FileList | File[] | undefined | null) {
    if (!list) return;
    if (!imageCapable) {
      onNotice('当前 Agent 不支持图片输入，无法添加图片');
      return;
    }
    const added = await addImageAttachments(attachments, [...list]);
    if (added.attachments.length !== attachments.length) setAttachments(added.attachments);
    for (const error of added.errors) onNotice(error);
  }

  function insertSkill(option: SkillOption) {
    runtime.setText(skillInsertText(option));
    setPickerIndex(-1);
    inputRef.current?.focus();
  }

  function insertTabRef(tab: BrowserTab) {
    const label = tabDisplayHost(tab.url, tab.title);
    const refToken = `@${label} `;
    const next = atMatch
      ? text.slice(0, text.length - (atMatch[1].length + 1)) + refToken
      : `${text}${text && !text.endsWith(' ') ? ' ' : ''}${refToken}`;
    runtime.setText(next);
    setPickerIndex(-1);
    setTabPickerDismissed(false);
    inputRef.current?.focus();
  }

  function triggerSymbol(symbol: '@' | '/') {
    setTabPickerDismissed(false);
    setPickerIndex(0);
    if (symbol === '/') {
      runtime.setText('/');
    } else {
      const current = runtime.getState().text;
      if (!/(?:^|\s)@$/.test(current)) {
        runtime.setText(`${current}${current && !current.endsWith(' ') ? ' ' : ''}@`);
      }
    }
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (composing.current) {
      composing.current = false;
      runtime.setText(event.currentTarget.value);
    }
    // 选择器打开时，方向键/回车/Esc 归选择器管，不落到发送逻辑。
    if (shownSkillPicker || shownTabPicker) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPickerIndex(-1);
        if (shownTabPicker) setTabPickerDismissed(true);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerIndex((index) => (index + 1) % Math.max(activePickerCount, 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerIndex(
          (index) => (index - 1 + Math.max(activePickerCount, 1)) % Math.max(activePickerCount, 1),
        );
        return;
      }
      if (event.key === 'Enter' && activePickerCount > 0) {
        event.preventDefault();
        const idx = pickerIndex >= 0 && pickerIndex < activePickerCount ? pickerIndex : 0;
        if (shownSkillPicker) insertSkill(options[idx]);
        else insertTabRef(tabOptions[idx]);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!locked) void onInterruptAndSend();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (locked) return;
      // 运行中不触发被禁用的发送，改为排队；没连上时由 ComposerPrimitive.Root 的 onSubmit 拦。
      if (busy) {
        onEnqueue(event.currentTarget.value, attachments);
        runtime.setText('');
        setAttachments([]);
      } else {
        event.currentTarget.form?.requestSubmit();
      }
    }
  }

  return (
    <div className={`composer-input${dropActive ? ' drop-active' : ''}`}>
      {dropActive && (
        <div
          className={`composer-drop-overlay${!imageCapable ? ' is-disabled' : ''}`}
          aria-hidden="true"
        >
          <ImagePlus size={18} />
          <span>{imageCapable ? '松开以添加图片附件' : '当前 Agent 不支持图片输入'}</span>
        </div>
      )}
      {shownSkillPicker && (
        <div className="skill-picker" role="listbox" aria-label="选择技能">
          <div className="picker-head">
            <Zap size={11} />
            技能{options.length > 0 ? ` · ${options.length}` : ''}
          </div>
          {options.length === 0 ? (
            <div className="skill-picker-empty">
              <SearchX size={15} />
              <span className="spe-col">
                {skillCount === 0 ? (
                  <>
                    <strong>没有已提炼的技能</strong>
                    <small>在技能库里把录制提炼成技能后，就能用 / 快速调用</small>
                  </>
                ) : (
                  <>
                    <strong>没有匹配「{pickerQuery}」的技能</strong>
                    <small>换个关键词，或按 Esc 关闭</small>
                  </>
                )}
              </span>
            </div>
          ) : (
            options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === pickerIndex}
                className="picker-option"
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSkill(option);
                }}
              >
                <span className="pk-name">/{option.name}</span>
                {option.about && <span className="pk-about">{option.about}</span>}
              </button>
            ))
          )}
          <div className="picker-foot">
            {options.length > 0 && (
              <>
                <span className="picker-keys">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd>
                  <em>选择</em>
                </span>
                <i aria-hidden>·</i>
                <span className="picker-keys">
                  <kbd>Enter</kbd>
                  <em>插入</em>
                </span>
                <i aria-hidden>·</i>
              </>
            )}
            <span className="picker-keys">
              <kbd>Esc</kbd>
              <em>关闭</em>
            </span>
          </div>
        </div>
      )}
      {shownTabPicker && (
        <div className="skill-picker tab-picker" role="listbox" aria-label="引用标签页">
          <div className="picker-head">
            <Globe2 size={11} />
            引用标签页 · {tabOptions.length}
          </div>
          {tabOptions.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="option"
              aria-selected={index === pickerIndex}
              className="picker-option"
              onMouseDown={(event) => {
                event.preventDefault();
                insertTabRef(tab);
              }}
            >
              <span className="pk-name">@{tabDisplayHost(tab.url, tab.title)}</span>
              {tab.title && <span className="pk-about">{tab.title}</span>}
            </button>
          ))}
          <div className="picker-foot">
            <span className="picker-keys">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <em>选择</em>
            </span>
            <i aria-hidden>·</i>
            <span className="picker-keys">
              <kbd>Enter</kbd>
              <em>引用</em>
            </span>
            <i aria-hidden>·</i>
            <span className="picker-keys">
              <kbd>Esc</kbd>
              <em>关闭</em>
            </span>
          </div>
        </div>
      )}
      {contextStrip}
      {attachments.length > 0 && (
        <div
          className="attachment-strip"
          aria-label={`${attachments.length} 张图片附件，最多 ${MAX_IMAGES_PER_PROMPT} 张`}
        >
          {attachments.map((attachment, index) => (
            <span
              className="attachment-thumb"
              key={`${attachment.name}-${index}`}
              title={attachment.name}
            >
              <img
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                alt={attachment.name}
              />
              <button
                type="button"
                className="attachment-remove"
                aria-label={`移除 ${attachment.name}`}
                onClick={() => setAttachments(attachments.filter((_, i) => i !== index))}
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            </span>
          ))}
          <span className="attachment-count">
            {attachments.length}/{MAX_IMAGES_PER_PROMPT}
          </span>
        </div>
      )}
      <textarea
        ref={inputRef}
        name="input"
        rows={1}
        aria-label="输入任务"
        placeholder={placeholder}
        defaultValue={runtime.getState().text}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setTabPickerDismissed(false);
          runtime.setText(event.currentTarget.value);
        }}
        onChange={(event) => {
          if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
          setTabPickerDismissed(false);
          runtime.setText(event.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = [...event.clipboardData.items]
            .filter((item) => item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (files.length) void acceptFiles(files);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
          void acceptFiles(event.dataTransfer.files);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
      />
      <div className="composer-toolbar">
        <div className="composer-left-group">
          <div className="composer-plus-anchor" ref={plusRef}>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                void acceptFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="composer-plus-btn"
              aria-label="添加上下文或附件"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              title="添加图片、@ 引用标签页、/ 调用技能"
              onClick={() => setPlusOpen((open) => !open)}
            >
              <Plus size={15} />
            </button>
            <div className="composer-plus-menu" role="menu" hidden={!plusOpen}>
              <button
                type="button"
                role="menuitem"
                disabled={!imageCapable}
                title={imageCapable ? '添加图片（最多 5 张，单张 ≤5MB）' : '当前 Agent 不支持图片'}
                onClick={() => {
                  setPlusOpen(false);
                  fileInput.current?.click();
                }}
              >
                <ImagePlus size={14} />
                <span>{imageCapable ? '添加图片' : '当前 Agent 不支持图片'}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={tabs.length === 0}
                onClick={() => {
                  setPlusOpen(false);
                  triggerSymbol('@');
                }}
              >
                <AtSign size={14} />
                <span>引用标签页 (@)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setPlusOpen(false);
                  triggerSymbol('/');
                }}
              >
                <Slash size={14} />
                <span>调用技能 (/)</span>
              </button>
            </div>
          </div>
          <div className="composer-options">{footerLeft}</div>
        </div>
        <div className="composer-right-actions">{footerRight}</div>
      </div>
    </div>
  );
}
