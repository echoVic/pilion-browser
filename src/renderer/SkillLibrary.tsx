import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
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
import { SkillEditor } from './SkillEditor';
import { failureText } from './ui';

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

/** 「过程」tab：进入时才读事件日志，行数、是否封顶、是否被砍过中间都由主进程算好。 */
function ProcessView({ id }: { id: string }) {
  // 结果按 id 认领，跟 detail/shown 一个套路：换一行之前，旧内容不会被当成新那行的过程。
  const [loaded, setLoaded] = useState<
    { id: string; lines: string[]; capped: boolean; clamped: boolean; error?: string } | undefined
  >();

  useEffect(() => {
    let cancelled = false;
    void window.pilion.skills
      .events(id)
      .then((result) => {
        if (!cancelled) setLoaded({ id, ...result });
      })
      .catch((cause: unknown) => {
        // 日志坏了时 parseEvents 会说清坏在第几行，就是为了让人去修；
        // 在这里吞掉它，屏幕上就只剩一份空列表，和「什么都没做过」分不出来。
        if (!cancelled)
          setLoaded({ id, lines: [], capped: false, clamped: false, error: failureText(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const shown = loaded?.id === id ? loaded : undefined;
  if (!shown) return <p className="skills-note">加载中…</p>;
  if (shown.error) return <p className="skills-error">过程记录读不出来：{shown.error}</p>;
  return (
    <>
      {/* capped：录制当时就到了上限，后面根本没记下。clamped：记下的比这里能显示的长，
          这一屏砍掉了中间。两件不同的事，各自说一句，互不蕴含。 */}
      {shown.capped ? <p className="skills-note">录制到达上限，后面的过程没有记下。</p> : null}
      {shown.clamped ? <p className="skills-note">过程比这里能显示的长，中间被省略了。</p> : null}
      <ul className="skills-process">
        {shown.lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </>
  );
}

export function SkillLibrary({ skills, busy, run, onPlay, distillation, agentConnected }: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(skills[0]?.id);
  const [detail, setDetail] = useState<SkillDetail | undefined>();
  const [tab, setTab] = useState<'steps' | 'trajectory' | 'process'>('steps');
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [prose, setProse] = useState('');
  const [steps, setSteps] = useState<SkillStepView[]>([]);
  const [dirty, setDirty] = useState(false);
  // 这次打开期间，已经被告知过重算提示的 id。skills 数组每次都是从主进程整份克隆过来的，
  // 跟这份录制无关的改动（改名、别的录制的列表刷新……）也会让 selected 换一个引用，
  // 把下面那个 effect 重新跑一遍；同一个 id 再读一次详情，acknowledgeRecompute 早就
  // 确认过了，响应里不会再带 recomputed。只靠 detail.recomputed 直接渲染就会看着提示
  // 一闪而过。改成认这个「这次打开见过没有」的记号，点另一行（唯一改 selectedId 的地方）
  // 才清掉。
  const [seenRecomputeFor, setSeenRecomputeFor] = useState<string | undefined>();
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];
  // 改名表单绑在它打开时的那一行上。删除会让 selected 落到另一行，那时表单必须自己收起来，
  // 否则「保存」会去改一个人根本没点改名的技能。
  const renaming = selected !== undefined && renamingId === selected.id;

  // The loaded detail is matched to the selected row by id rather than cleared on switch, so a
  // row never borrows the previous row's steps while its own read is still in flight.
  const shown = selected && !selected.error && detail?.id === selected.id ? detail : undefined;
  // 提炼状态同样按 id 认领，换一行就不再是这行的横幅。
  const distilling = selected && distillation?.id === selected.id ? distillation : undefined;
  // 「过程」tab 只在有事件日志时才存在；选中的录制换成没有日志的那一行时退回「步骤」。
  const activeTab = tab === 'process' && !selected?.hasEvents ? 'steps' : tab;
  const recomputedNotice = shown ? shown.recomputed || seenRecomputeFor === shown.id : false;

  useEffect(() => {
    if (!selected || selected.error) return;
    let cancelled = false;
    void window.pilion.skills
      .read(selected.id)
      .then((loaded) => {
        // 不管这次读取有没有被下面的 cancelled 判定甩掉，「曾经带着 recomputed 回来过」
        // 这件事本身仍然成立，标记要留下——被甩掉的通常正是刚确认完、紧跟着触发的那次
        // 重读，它自己反而读不到 recomputed 了。
        if (loaded.recomputed) setSeenRecomputeFor(loaded.id);
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
                  // 换一行就是重新打开：上一行「看过重算提示」的记号不该带过来。
                  setSeenRecomputeFor(undefined);
                }}
              >
                <Clapperboard size={18} />
                <div>
                  <strong>{item.name}</strong>
                  {/* 有一条还没看过的重算提示：不用点开这一行也能看出是哪一份。 */}
                  <span>
                    {item.error
                      ? '文件读不出来'
                      : `${item.steps} 步${item.needsHuman ? ` · 需人工 ${item.needsHuman}` : ''}${
                          item.unsupported ? ` · ${item.unsupported} 步回放不了` : ''
                        }${item.recomputed ? ' · 步骤已重算' : ''} · ${
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
                    onClick={() => {
                      // 播放要切回网页视图，这个组件会被卸载，编辑器连同没保存的改动一起没了。
                      if (!leaveEditing()) return;
                      onPlay(selected.id);
                    }}
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
                      // 保留会重写文件；编辑器里那份副本已经读过旧文件，留着它保存就把提炼盖回去了。
                      disabled={busy || editing}
                      title={editing ? '先保存或取消当前编辑' : undefined}
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
                <SkillEditor
                  id={selected.id}
                  busy={busy}
                  run={run}
                  prose={prose}
                  setProse={setProse}
                  steps={steps}
                  setSteps={setSteps}
                  setDirty={setDirty}
                  setEditing={setEditing}
                  onCancel={leaveEditing}
                />
              ) : (
                <>
                  {/* 提示记在技能库对象里，直到这份录制的详情被打开一次为止；打开详情本身
                      就是确认，所以只说一次。recomputedNotice 认的是 shown（这次详情响应）
                      而不是 selected（列表摘要）：确认之后列表会跟着刷新，selected.recomputed
                      跟着变 false，这句话不会跟着列表一起消失；它还认「这次打开期间是否已经
                      见过」，同一份录制开着不动时，因为别的改动导致的重读丢了 recomputed 也
                      不会把已经说过的话收回去。 */}
                  {recomputedNotice ? (
                    <p className="skills-note">步骤已按过程记录重算，手工改动未保留。</p>
                  ) : null}
                  <div className="skills-tabs" role="tablist">
                    <button
                      role="tab"
                      aria-selected={activeTab === 'steps'}
                      onClick={() => setTab('steps')}
                    >
                      步骤
                    </button>
                    <button
                      role="tab"
                      aria-selected={activeTab === 'trajectory'}
                      onClick={() => setTab('trajectory')}
                    >
                      轨迹
                    </button>
                    {selected.hasEvents ? (
                      <button
                        role="tab"
                        aria-selected={activeTab === 'process'}
                        onClick={() => setTab('process')}
                      >
                        过程
                      </button>
                    ) : null}
                  </div>
                  {activeTab === 'steps' ? (
                    <StepRows steps={shown?.steps ?? []} />
                  ) : activeTab === 'trajectory' ? (
                    <div className="skills-trajectory">
                      {/* 有过程记录的录制，步骤是算出来的，读取时会按日志重算覆盖手改；
                          没有日志的第一期老录制，这个文件就是唯一真相，手改真的算数。 */}
                      <p className="skills-note">
                        {selected.hasEvents
                          ? '步骤是从过程记录算出来的，直接改这个文件不作数；要改请提炼成技能后再改。'
                          : '这份录制没有过程记录，文件里的代码块就是步骤的唯一真相，直接改算数。'}
                      </p>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {shown?.markdown ?? ''}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <ProcessView id={selected.id} />
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
