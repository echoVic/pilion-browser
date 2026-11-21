import { useRef, useState } from 'react';
import type { RecordingState } from '../shared/contracts';
import { failureText } from './ui';

/**
 * 「保存」这一下停止录制的进度。保存失败时主进程留着录到的操作、录制照旧进行，
 * 原因就留在录制条上，再点一次「保存」会重试；不再只丢给全局错误条。
 */
type StopPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'failed'; readonly reason: string };

const IDLE: StopPhase = { kind: 'idle' };

export interface RecordingStop {
  readonly phase: StopPhase;
  save(name: string): Promise<void>;
  /** 回到 idle：继续录、或开始新的一段录制时，旧的失败说明不再适用。 */
  reset(): void;
}

/**
 * 停止录制的状态放在 App 这一层，不放在录制条里：主进程停止期间广播的状态里暂时没有
 * recording，录制条会卸载；保存失败、录制恢复后它重新挂上，失败原因还得在。
 */
export function useRecordingStop(onSaved: () => void): RecordingStop {
  const [phase, setPhase] = useState<StopPhase>(IDLE);
  // 同一拍里连按两下「保存」时 state 还没更新，用 ref 挡住第二次停止。
  const saving = useRef(false);
  const save = async (name: string) => {
    if (saving.current) return;
    saving.current = true;
    setPhase({ kind: 'saving' });
    try {
      await window.pilion.recording.stop(name);
    } catch (cause) {
      setPhase({ kind: 'failed', reason: failureText(cause).replace(/[。.]$/, '') });
      return;
    } finally {
      saving.current = false;
    }
    setPhase(IDLE);
    onSaved();
  };
  return { phase, save, reset: () => setPhase(IDLE) };
}

type Props = {
  recording: RecordingState;
  /** 正在给这份录制起名字（点了停止录制之后）。 */
  naming: boolean;
  name: string;
  onNameChange(name: string): void;
  /** 「继续录」：收起起名表单，接着录。 */
  onContinue(): void;
  onCancel(): void;
  stop: RecordingStop;
  note: string;
  onNoteChange(note: string): void;
  run(action: () => Promise<unknown>): Promise<boolean>;
};

/** 浏览器上方的录制条：步数、录不下来的提示、旁白输入，以及停止时的起名与保存。 */
export function RecordingBar({
  recording,
  naming,
  name,
  onNameChange,
  onContinue,
  onCancel,
  stop,
  note,
  onNoteChange,
  run,
}: Props) {
  return (
    <div className="recording-bar" role="status" aria-live="polite">
      <span className="recording-dot" aria-hidden="true" />
      <strong>录制中 · {recording.steps} 步</strong>
      {recording.unsupported > 0 ? (
        <span className="recording-warn" title="这些步骤回放不了，提炼时会变成「需要我」">
          {recording.unsupported} 步回放不了
        </span>
      ) : null}
      {recording.capped ? (
        <span className="recording-warn">已达到录制上限，后面的操作不会记下</span>
      ) : null}
      {naming && stop.phase.kind === 'failed' ? (
        <span className="recording-warn" role="alert">
          录制没有保存成功：{stop.phase.reason}。再点一次「保存」会重试。
        </span>
      ) : null}
      {naming ? (
        <form
          className="recording-name"
          onSubmit={(event) => {
            event.preventDefault();
            void stop.save(name);
          }}
        >
          <input
            autoFocus
            aria-label="录制名称"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            maxLength={120}
          />
          <button
            type="submit"
            className="secondary-button"
            disabled={!name.trim() || stop.phase.kind === 'saving'}
          >
            保存
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              stop.reset();
              onContinue();
            }}
          >
            继续录
          </button>
          <button
            type="button"
            className="text-button"
            disabled={stop.phase.kind === 'saving'}
            onClick={onCancel}
          >
            取消录制
          </button>
        </form>
      ) : (
        <form
          className="recording-note"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!note.trim()) return;
            if (await run(() => window.pilion.recording.note(note))) onNoteChange('');
          }}
        >
          <input
            aria-label="录制旁白"
            placeholder="加一句旁白，例如：这里要选上个月"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            maxLength={2000}
          />
        </form>
      )}
    </div>
  );
}
