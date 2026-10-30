import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ThreadComposerRuntime } from '@assistant-ui/react';
import { ImagePlus, SearchX, X, Zap } from 'lucide-react';
import type { PromptAttachment, RecordingSummary } from '../shared/contracts.js';
import { MAX_IMAGES_PER_PROMPT } from '../shared/contracts.js';
import { readImageAttachment } from './composer/attachments.js';
import { filterSkills, skillInsertText, type SkillOption } from './composer/skill-picker.js';
import { IconButton } from './ui';

type Props = {
  runtime: ThreadComposerRuntime;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  /** Agent 是否正在跑：Enter 在运行时改为排队，而不是触发被禁用的发送。 */
  busy: boolean;
  /** Agent 公布了 promptCapabilities.image。false 时禁掉图片并提示。 */
  imageCapable: boolean;
  skills: readonly RecordingSummary[];
  attachments: PromptAttachment[];
  setAttachments(attachments: PromptAttachment[]): void;
  onNotice(message: string): void;
  /** 运行中按 Enter：把当前输入排队。 */
  onEnqueue(text: string, attachments: PromptAttachment[]): void;
  /** Cmd/Ctrl+Enter：先打断当前回合，收尾后立即发送当前输入与队列。 */
  onInterruptAndSend(text: string, attachments: PromptAttachment[]): void;
};

export function ComposerInput({
  runtime,
  inputRef,
  placeholder,
  busy,
  imageCapable,
  skills,
  attachments,
  setAttachments,
  onNotice,
  onEnqueue,
  onInterruptAndSend,
}: Props) {
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickerIndex, setPickerIndex] = useState(-1);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    const sync = () => {
      const input = inputRef.current;
      const text = runtime.getState().text;
      if (input && !composing.current && input.value !== text) input.value = text;
    };
    sync();
    return runtime.subscribe(sync);
  }, [runtime, inputRef]);

  const text = runtime.getState().text;
  // 「/」选择器：输入以 / 开头、且还没有空格时展开。查询就是 / 后面的部分。
  const pickerQuery = /^\/(\S*)$/.test(text) ? text.slice(1) : null;
  const options: SkillOption[] = pickerQuery === null ? [] : filterSkills(skills, pickerQuery);
  const skillCount = filterSkills(skills, '').length;
  const shownPicker = pickerQuery !== null && (options.length > 0 || pickerQuery.length > 0);

  async function acceptFiles(list: FileList | File[] | undefined | null) {
    if (!list) return;
    if (!imageCapable) {
      onNotice('当前 Agent 不支持图片输入，无法添加图片');
      return;
    }
    for (const file of [...list]) {
      if (!file.type.startsWith('image/')) continue;
      const outcome = await readImageAttachment(file, attachments.length);
      if (!outcome.ok) {
        onNotice(outcome.error);
        continue;
      }
      setAttachments([...attachments, outcome.attachment].slice(0, MAX_IMAGES_PER_PROMPT));
    }
  }

  function insertSkill(option: SkillOption) {
    runtime.setText(skillInsertText(option));
    setPickerIndex(-1);
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (composing.current) {
      composing.current = false;
      runtime.setText(event.currentTarget.value);
    }
    // 选择器打开时，方向键/回车/Esc 归选择器管，不落到发送逻辑。
    if (shownPicker) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPickerIndex(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerIndex((index) => (index + 1) % Math.max(options.length, 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerIndex((index) => (index - 1 + options.length) % Math.max(options.length, 1));
        return;
      }
      if (event.key === 'Enter' && options.length) {
        event.preventDefault();
        insertSkill(options[pickerIndex >= 0 ? pickerIndex : 0]);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onInterruptAndSend(event.currentTarget.value, attachments);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
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
      {shownPicker && (
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
        rows={3}
        aria-label="输入任务"
        placeholder={placeholder}
        defaultValue={runtime.getState().text}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          runtime.setText(event.currentTarget.value);
        }}
        onChange={(event) => {
          if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
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
      <div className="composer-input-bar">
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
        <IconButton
          label={imageCapable ? '添加图片' : '当前 Agent 不支持图片'}
          title={imageCapable ? '添加图片（最多 5 张，单张 ≤5MB）' : '当前 Agent 不支持图片'}
          disabled={!imageCapable}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={15} />
        </IconButton>
      </div>
    </div>
  );
}
