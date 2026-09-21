import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  FolderOpen,
  Pencil,
  Play,
  Sparkles,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import type {
  DistillationState,
  RecordingSummary,
  SkillDetail,
  SkillStepView,
} from '../shared/contracts';

type Props = {
  skills: RecordingSummary[];
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<unknown>;
  /** 播放前切回网页视图，蒙层与回放条在那里。 */
  onPlay(id: string): void;
  /** 主进程里同时只有一次提炼；id 对不上当前这行就不关这行的事。 */
  distillation?: DistillationState;
  /** 没有连上并接管的 Agent 就没人能提炼。 */
  agentConnected: boolean;
};

/** 提炼出来的 md 里，散文写在这个块上面。 */
const SKILL_BLOCK = '```json pilion-skill';

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

/** 只读的步骤表：技能自己的步骤和提案的步骤都用它。 */
function StepRows({ steps }: { steps: SkillStepView[] }) {
  return (
    <ol className="skills-steps">
      {steps.map((step) => (
        <li
          key={step.index}
          className={[
            step.unsupported ? 'unsupported' : step.ambiguous ? 'ambiguous' : '',
            step.manual ? 'manual' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="step-index">{step.index}</span>
          <span className="step-text">{step.text}</span>
          {step.unsupported ? (
            <span className="step-mark">回放不了：{step.unsupported}</span>
          ) : null}
          {step.ambiguous ? <span className="step-mark">录制时目标描述不唯一</span> : null}
          {step.manual ? <span className="step-mark">手工添加</span> : null}
        </li>
      ))}
    </ol>
  );
}

export function SkillLibrary({ skills, busy, run, onPlay, distillation, agentConnected }: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(skills[0]?.id);
  const [detail, setDetail] = useState<SkillDetail | undefined>();
  const [tab, setTab] = useState<'steps' | 'trajectory'>('steps');
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [prose, setProse] = useState('');
  const [steps, setSteps] = useState<SkillStepView[]>([]);
  const [dirty, setDirty] = useState(false);
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];
  // 改名表单绑在它打开时的那一行上。删除会让 selected 落到另一行，那时表单必须自己收起来，
  // 否则「保存」会去改一个人根本没点改名的技能。
  const renaming = selected !== undefined && renamingId === selected.id;

  // The loaded detail is matched to the selected row by id rather than cleared on switch, so a
  // row never borrows the previous row's steps while its own read is still in flight.
  const shown = selected && !selected.error && detail?.id === selected.id ? detail : undefined;
  // 提炼状态同样按 id 认领，换一行就不再是这行的横幅。
  const distilling = selected && distillation?.id === selected.id ? distillation : undefined;

  useEffect(() => {
    if (!selected || selected.error) return;
    let cancelled = false;
    void window.pilion.skills
      .read(selected.id)
      .then((loaded) => {
        if (!cancelled) setDetail(loaded);
      })
      .catch(() => {
        if (!cancelled) setDetail(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // 编辑的是本地副本，换行或取消都会丢掉它，所以改过就先问一声。
  function leaveEditing(): boolean {
    if (editing && dirty && !window.confirm('放弃这个技能未保存的修改？')) return false;
    setEditing(false);
    setDirty(false);
    return true;
  }

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
    const onUrl = previous?.raw.onUrl ?? previous?.raw.url ?? steps[0]?.raw.url ?? '';
    const human: SkillStepView = {
      index: 0,
      kind: 'human',
      text: '需要我：',
      raw: { kind: 'human', onUrl, reason: '' },
    };
    reviseSteps([...steps.slice(0, position), human, ...steps.slice(position)]);
  }

  return (
    <div className="library-surface skills-surface">
      <header className="surface-header">
        <div>
          <span className="eyebrow">工作区</span>
          <h1>技能库</h1>
        </div>
      </header>
      {skills.length === 0 ? (
        <div className="empty-list">
          <Clapperboard size={30} />
          <h2>还没有录制</h2>
          <p>在任意网页点工具栏的 ● 开始录制你的操作，停止后会出现在这里。</p>
        </div>
      ) : (
        <div className="skills-layout">
          <div className="skills-list" role="list">
            {skills.map((item) => (
              <button
                role="listitem"
                key={item.id}
                className={`library-row ${item.id === selected?.id ? 'selected' : ''}`}
                onClick={() => {
                  if (!leaveEditing()) return;
                  setSelectedId(item.id);
                  setRenamingId(undefined);
                }}
              >
                <Clapperboard size={18} />
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.error
                      ? '文件读不出来'
                      : `${item.steps} 步${item.needsHuman ? ` · 需人工 ${item.needsHuman}` : ''}${
                          item.unsupported ? ` · ${item.unsupported} 步回放不了` : ''
                        } · ${
                          item.distilled
                            ? item.about
                              ? `已提炼 · ${item.about}`
                              : '已提炼'
                            : '仅轨迹 · Agent 看不到'
                        }`}
                  </span>
                </div>
                {item.error || item.unsupported ? (
                  <TriangleAlert size={16} className="warn" />
                ) : null}
              </button>
            ))}
          </div>
          {selected ? (
            <section className="skills-detail" aria-label={selected.name}>
              <header>
                {renaming ? (
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      if (await run(() => window.pilion.skills.rename(selected.id, name)))
                        setRenamingId(undefined);
                    }}
                  >
                    <input
                      autoFocus
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={120}
                      aria-label="技能名称"
                    />
                    <button type="submit" className="secondary-button" disabled={!name.trim()}>
                      保存
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRenamingId(undefined)}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <h2>
                    {selected.name}
                    <button
                      className="text-button"
                      aria-label="改名"
                      onClick={() => {
                        setName(selected.name);
                        setRenamingId(selected.id);
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                  </h2>
                )}
                <div className="surface-header-actions">
                  <button
                    className="secondary-button"
                    disabled={busy || Boolean(selected.error)}
                    onClick={() => onPlay(selected.id)}
                  >
                    <Play size={16} />
                    播放
                  </button>
                  {selected.distilled && !selected.error && !editing ? (
                    <button
                      className="text-button"
                      disabled={busy || !shown}
                      onClick={() => {
                        if (!shown) return;
                        setProse(shown.prose ?? '');
                        setSteps(shown.steps);
                        setDirty(false);
                        setEditing(true);
                      }}
                    >
                      <Pencil size={16} />
                      编辑
                    </button>
                  ) : null}
                  {selected.error ? null : (
                    <button
                      className="text-button"
                      disabled={!agentConnected || busy || distillation?.status === 'running'}
                      title={agentConnected ? undefined : '先连接 Agent'}
                      onClick={() => void run(() => window.pilion.skills.distill(selected.id))}
                    >
                      <Sparkles size={16} />
                      {selected.distilled ? '重炼' : '提炼'}
                    </button>
                  )}
                  <button
                    className="text-button"
                    onClick={() => void run(() => window.pilion.skills.show(selected.id))}
                  >
                    <FolderOpen size={16} />在 Finder 中显示
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`删除「${selected.name}」？轨迹文件会一起删除。`)) return;
                      if (await run(() => window.pilion.skills.remove(selected.id))) {
                        setRenamingId(undefined);
                        setName('');
                        setEditing(false);
                        setDirty(false);
                      }
                    }}
                  >
                    <Trash size={16} />
                    删除
                  </button>
                </div>
              </header>
              {distilling?.status === 'running' ? (
                <div className="distill-banner running">提炼中…（可在右侧对话里看到过程）</div>
              ) : null}
              {distilling?.status === 'rejected' ? (
                <div className="distill-banner rejected">
                  提炼未通过：{distilling.reason}
                  <button
                    className="text-button"
                    disabled={!agentConnected || busy}
                    title={agentConnected ? undefined : '先连接 Agent'}
                    onClick={() => void run(() => window.pilion.skills.distill(selected.id))}
                  >
                    重炼
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void run(() => window.pilion.skills.discard())}
                  >
                    关闭
                  </button>
                </div>
              ) : null}
              {distilling?.status === 'proposed' ? (
                <>
                  <div className="distill-banner proposed">
                    Agent 提炼好了，看一遍再决定
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void run(() => window.pilion.skills.keep())}
                    >
                      保留
                    </button>
                    <button
                      className="text-button"
                      onClick={() => void run(() => window.pilion.skills.discard())}
                    >
                      丢弃
                    </button>
                    <button
                      className="text-button"
                      disabled={!agentConnected || busy}
                      title={agentConnected ? undefined : '先连接 Agent'}
                      onClick={() => void run(() => window.pilion.skills.distill(selected.id))}
                    >
                      重炼
                    </button>
                  </div>
                  <div className="distill-proposal">
                    <div className="skills-trajectory">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {(distilling.markdown ?? '').split(SKILL_BLOCK)[0]}
                      </ReactMarkdown>
                    </div>
                    <StepRows steps={distilling.steps ?? []} />
                  </div>
                </>
              ) : null}
              {selected.error ? (
                <p className="skills-error">{selected.error}</p>
              ) : editing ? (
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
                          <button
                            className="text-button skills-insert"
                            onClick={() => insertHuman(position)}
                          >
                            + 需要我
                          </button>
                        </li>,
                        <li
                          key={`${position}-${step.kind}`}
                          className={step.manual ? 'manual' : ''}
                        >
                          <span className="step-index">{step.index}</span>
                          <span className="step-text">{step.text}</span>
                          {editable ? (
                            <input
                              value={String(step.raw[editable.field] ?? '')}
                              aria-label={editable.label}
                              onChange={(event) =>
                                changeValue(position, editable.field, event.target.value)
                              }
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
                      <button
                        className="text-button skills-insert"
                        onClick={() => insertHuman(steps.length)}
                      >
                        + 需要我
                      </button>
                    </li>
                  </ol>
                  <div className="surface-header-actions skills-edit-actions">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={async () => {
                        const saved = await run(() =>
                          window.pilion.skills.save(
                            selected.id,
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
                    <button className="text-button" onClick={() => leaveEditing()}>
                      取消
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="skills-tabs" role="tablist">
                    <button
                      role="tab"
                      aria-selected={tab === 'steps'}
                      onClick={() => setTab('steps')}
                    >
                      步骤
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === 'trajectory'}
                      onClick={() => setTab('trajectory')}
                    >
                      轨迹
                    </button>
                  </div>
                  {tab === 'steps' ? (
                    <StepRows steps={shown?.steps ?? []} />
                  ) : (
                    <div className="skills-trajectory">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {shown?.markdown ?? ''}
                      </ReactMarkdown>
                    </div>
                  )}
                </>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
