import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, ArrowUp, Trash } from 'lucide-react';
import type { SkillStepView } from '../shared/contracts';

type Props = {
  /** 保存时提交给主进程的技能 id。 */
  id: string;
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<unknown>;
  prose: string;
  setProse(value: string): void;
  steps: SkillStepView[];
  setSteps(steps: SkillStepView[]): void;
  setDirty(dirty: boolean): void;
  setEditing(editing: boolean): void;
  /** 取消编辑；脏了要不要弹确认由它决定，跟父组件里切换选中行、去播放共用同一个函数。 */
  onCancel(): void;
};

/** 只有这三种步骤的值能改；动作步骤既不能新建，也不能换目标。 */
const EDITABLE_VALUE: Record<string, { field: string; label: string } | undefined> = {
  type: { field: 'text', label: '输入的文字' },
  select: { field: 'value', label: '选中的值' },
  human: { field: 'reason', label: '需要我做的事' },
};

/** 编辑时行文本从 raw 现算，改完一个值立刻看到改完的样子。 */
function describeRaw(raw: Record<string, unknown>): string {
  const target = raw.target as { name?: string } | undefined;
  switch (raw.kind) {
    case 'navigate':
      return `打开 ${raw.url}`;
    case 'type':
      return `输入 "${target?.name ?? ''}" = "${raw.text}"`;
    case 'select':
      return `选择 "${target?.name ?? ''}" = "${raw.value}"`;
    case 'human':
      return `需要我：${raw.reason}`;
    case 'note':
      return `备注：${raw.text}`;
    default:
      return String(raw.kind);
  }
}

/** 技能的编辑器：散文 + 步骤表，改完调用 skills.save。步骤只能在轨迹里挑、排、删，不能新增动作。 */
export function SkillEditor({
  id,
  busy,
  run,
  prose,
  setProse,
  steps,
  setSteps,
  setDirty,
  setEditing,
  onCancel,
}: Props) {
  // 说明空着的「需要我」保存时会被 StepSchema 拒掉，所以先按住保存，别让人白跑一趟。
  const missingReason = steps.some(
    (step) => step.kind === 'human' && !String(step.raw.reason ?? '').trim(),
  );

  // 序号只用来显示，每次结构操作后重排。
  function reviseSteps(next: SkillStepView[]) {
    setSteps(next.map((step, position) => ({ ...step, index: position + 1 })));
    setDirty(true);
  }

  function moveStep(position: number, delta: number) {
    const target = position + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const moved = next[position];
    next[position] = next[target];
    next[target] = moved;
    reviseSteps(next);
  }

  function changeValue(position: number, field: string, value: string) {
    const next = [...steps];
    const step = next[position];
    const raw = { ...step.raw, [field]: value };
    next[position] = { ...step, raw, text: describeRaw(raw) };
    reviseSteps(next);
  }

  // 插进来的「需要我」记在上一步所在的页上，第一步之前就记在录制的起点。
  function insertHuman(position: number) {
    const previous = position > 0 ? steps[position - 1] : undefined;
    const onUrl =
      previous?.raw.onUrl ?? previous?.raw.url ?? steps[0]?.raw.onUrl ?? steps[0]?.raw.url;
    // 没有地址就插不了：「需要我」在这里只能改说明、改不了地址，而没有 onUrl 的步骤保存时
    // 会被 StepSchema 拒掉，人只能删了重来。与其插一个存不下的步骤，不如当场说明白。
    if (typeof onUrl !== 'string' || !onUrl) {
      void run(() =>
        Promise.reject(new Error('这一步没有可记的页面地址，请插到一个有地址的步骤后面')),
      );
      return;
    }
    const human: SkillStepView = {
      index: 0,
      kind: 'human',
      text: '需要我：',
      raw: { kind: 'human', onUrl, reason: '' },
    };
    reviseSteps([...steps.slice(0, position), human, ...steps.slice(position)]);
  }

  return (
    <>
      <div className="skills-editor">
        <textarea
          value={prose}
          aria-label="技能说明"
          onChange={(event) => {
            setProse(event.target.value);
            setDirty(true);
          }}
        />
        <div className="skills-trajectory">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{prose}</ReactMarkdown>
        </div>
      </div>
      <ol className="skills-steps">
        {steps.flatMap((step, position) => {
          const editable = EDITABLE_VALUE[step.kind];
          return [
            <li key={`insert-${position}`} className="skills-insert-row">
              <button className="text-button skills-insert" onClick={() => insertHuman(position)}>
                + 需要我
              </button>
            </li>,
            <li key={`${position}-${step.kind}`} className={step.manual ? 'manual' : ''}>
              <span className="step-index">{step.index}</span>
              <span className="step-text">{step.text}</span>
              {editable ? (
                <input
                  value={String(step.raw[editable.field] ?? '')}
                  aria-label={editable.label}
                  onChange={(event) => changeValue(position, editable.field, event.target.value)}
                />
              ) : null}
              {step.manual ? <span className="step-mark">手工添加</span> : null}
              <div className="step-actions">
                <button
                  className="text-button"
                  aria-label="上移"
                  disabled={position === 0}
                  onClick={() => moveStep(position, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  className="text-button"
                  aria-label="下移"
                  disabled={position === steps.length - 1}
                  onClick={() => moveStep(position, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  className="text-button danger"
                  aria-label="删除这步"
                  onClick={() => reviseSteps(steps.filter((_, at) => at !== position))}
                >
                  <Trash size={14} />
                </button>
              </div>
            </li>,
          ];
        })}
        <li className="skills-insert-row">
          <button className="text-button skills-insert" onClick={() => insertHuman(steps.length)}>
            + 需要我
          </button>
        </li>
      </ol>
      <div className="surface-header-actions skills-edit-actions">
        <button
          className="secondary-button"
          disabled={busy || missingReason}
          title={missingReason ? '「需要我」需要填写说明' : undefined}
          onClick={async () => {
            const saved = await run(() =>
              window.pilion.skills.save(
                id,
                prose,
                steps.map((step) => step.raw),
              ),
            );
            if (saved) {
              setEditing(false);
              setDirty(false);
            }
          }}
        >
          保存
        </button>
        <button className="text-button" onClick={() => onCancel()}>
          取消
        </button>
      </div>
    </>
  );
}
