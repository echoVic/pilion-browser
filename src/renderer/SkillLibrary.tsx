import { useEffect, useState } from 'react';
import clsx from 'clsx';
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
import { revealLabel } from './panel/links';
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

/**
 * 详情区当前在做什么，且绑在打开它的那一份技能上：选中行变了（比如删掉、被别处移走），
 * 绑在旧 id 上的改名表单或编辑器就不再显示，保存也不会落到另一份技能上。
 */
type EditorMode =
  | { readonly kind: 'view' }
  | { readonly kind: 'renaming'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'editing';
      readonly id: string;
      readonly prose: string;
      readonly steps: SkillStepView[];
      readonly dirty: boolean;
    };
const VIEW: EditorMode = { kind: 'view' };

/** 一次 skills.read 的结果，按 id 认领；还没有这一份的结果就是在加载。 */
type DetailLoad =
  | { readonly id: string; readonly kind: 'ok'; readonly detail: SkillDetail }
  | { readonly id: string; readonly kind: 'error'; readonly message: string };

/** 提炼出来的 md 里，散文写在这个块上面。 */
const SKILL_BLOCK = '```json pilion-skill';

/** 落盘的是英文枚举，界面上按枚举说人话；遇到不认识的新枚举原样展示兜底。 */
const UNSUPPORTED_REASON_TEXT: Record<string, string> = {
  iframe: '操作发生在嵌入框架（iframe）内',
  'out-of-scope': '目标超出录制范围',
  gesture: '拖拽、右键菜单等手势无法录制',
  'beyond-observe-limit': '目标超出可观察范围',
  'rich-text': '富文本编辑器内容需要手动填写',
  'url-too-long': '地址过长，无法按原样打开',
};

/** 只读的步骤表：技能自己的步骤和提案的步骤都用它。 */
function StepRows({ steps }: { steps: SkillStepView[] }) {
  return (
    <ol className="skills-steps">
      {steps.map((step) => (
        <li
          key={step.index}
          className={clsx({
            unsupported: step.unsupported,
            ambiguous: !step.unsupported && step.ambiguous,
            manual: step.manual,
          })}
        >
          <span className="step-index">{step.index}</span>
          <span className="step-text">{step.text}</span>
          {step.unsupported ? (
            <span className="step-mark">
              回放不了：{UNSUPPORTED_REASON_TEXT[step.unsupported] ?? step.unsupported}
            </span>
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
  const [load, setLoad] = useState<DetailLoad | undefined>();
  const [tab, setTab] = useState<'steps' | 'trajectory' | 'process'>('steps');
  const [mode, setMode] = useState<EditorMode>(VIEW);
  // 详情不是只在换选中行时才该重读：改名、保存编辑、保留提炼都会改掉选中这份录制自己的
  // 内容，但都不换 id。这几个操作成功后调用 reload() 让下面的 effect 重新跑一遍；
  // 效果只是数字变了，值本身不用来读。
  const [reloadToken, setReloadToken] = useState(0);
  function reload(): void {
    setReloadToken((token) => token + 1);
  }
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];
  // 改名表单和编辑器都绑在打开时的那一行上。删除会让 selected 落到另一行，那时它们必须自己收起来，
  // 否则「保存」会去改一个人根本没点改名或编辑的技能。
  const renaming = mode.kind === 'renaming' && mode.id === selected?.id ? mode : undefined;
  const editing = mode.kind === 'editing' && mode.id === selected?.id ? mode : undefined;
  const updateEditing = (
    change: (current: Extract<EditorMode, { kind: 'editing' }>) => EditorMode,
  ) => setMode((current) => (current.kind === 'editing' ? change(current) : current));

  // The loaded detail is matched to the selected row by id rather than cleared on switch, so a
  // row never borrows the previous row's steps while its own read is still in flight.
  const loaded = selected && !selected.error && load?.id === selected.id ? load : undefined;
  const shown = loaded?.kind === 'ok' ? loaded.detail : undefined;
  const detailError = loaded?.kind === 'error' ? loaded.message : undefined;
  // 提炼状态同样按 id 认领，换一行就不再是这行的横幅。
  const distilling = selected && distillation?.id === selected.id ? distillation : undefined;
  // 「过程」tab 只在有事件日志时才存在；选中的录制换成没有日志的那一行时退回「步骤」。
  const activeTab = tab === 'process' && !selected?.hasEvents ? 'steps' : tab;

  // 只认 id、不认 selected 这个对象本身：它是从主进程整份状态里现取的，IPC 每次
  // emit() 都会把 skills 数组重新克隆一遍，跟这份录制无关的改动（别的录制改名、任何
  // 别处的状态广播……）也会让它换一个引用。键在对象上会让下面这个 effect 跟着那些无关
  // 广播反复重读；键在这个 id 上，只有真的换了录制、或者这份录制从读得出来变成读不出来，
  // activeId 才会变——这份录制自己内容变了但 id 没变的几种情况（改名、保存编辑、保留
  // 提炼）靠 reload() 显式触发，见下面三处调用。
  const activeId = selected && !selected.error ? selected.id : undefined;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void window.pilion.skills
      .read(activeId)
      .then((detail) => {
        if (!cancelled) setLoad({ id: activeId, kind: 'ok', detail });
      })
      .catch((cause: unknown) => {
        // 读不出来要说出来；清成空详情会和「这份技能一步都没有」分不出来。
        if (!cancelled) setLoad({ id: activeId, kind: 'error', message: failureText(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, reloadToken]);

  // 编辑的是本地副本，换行或取消都会丢掉它，所以改过就先问一声。
  function leaveEditing(): boolean {
    if (editing?.dirty && !window.confirm('放弃这个技能未保存的修改？')) return false;
    setMode(VIEW);
    return true;
  }

  return (
    <div className="library-surface skills-surface">
      <header className="surface-header">
        <h1>技能库</h1>
      </header>
      {skills.length === 0 ? (
        <div className="empty-list">
          <Clapperboard size={26} />
          <h2>还没有录制</h2>
          <p>在任意网页点工具栏的 ● 开始录制你的操作，停止后会出现在这里。</p>
        </div>
      ) : (
        <div className="skills-layout">
          <div className="skills-list" role="list">
            {skills.map((item) => (
              <div role="listitem" key={item.id}>
                <button
                  className={clsx('library-row', { selected: item.id === selected?.id })}
                  onClick={() => {
                    if (!leaveEditing()) return;
                    setSelectedId(item.id);
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
                    <TriangleAlert size={16} className={clsx('warn', { 'is-error': item.error })} />
                  ) : null}
                </button>
              </div>
            ))}
          </div>
          {selected ? (
            <section className="skills-detail" aria-label={selected.name}>
              <header>
                {renaming ? (
                  <form
                    onSubmit={async (event) => {
                      event.preventDefault();
                      // 用打开表单时记下的 id，而不是提交这一刻的选中行。
                      const { id, name } = renaming;
                      if (await run(() => window.pilion.skills.rename(id, name))) {
                        setMode((current) =>
                          current.kind === 'renaming' && current.id === id ? VIEW : current,
                        );
                        // 改的是这份录制自己的名字，id 没变，effect 不会自己重读。
                        reload();
                      }
                    }}
                  >
                    <input
                      autoFocus
                      value={renaming.name}
                      onChange={(event) => {
                        const name = event.target.value;
                        setMode((current) =>
                          current.kind === 'renaming' ? { ...current, name } : current,
                        );
                      }}
                      maxLength={120}
                      aria-label="技能名称"
                    />
                    <button
                      type="submit"
                      className="secondary-button"
                      disabled={!renaming.name.trim()}
                    >
                      保存
                    </button>
                    <button type="button" className="text-button" onClick={() => setMode(VIEW)}>
                      取消
                    </button>
                  </form>
                ) : (
                  <h2>
                    <span className="skills-detail-title" title={selected.name}>
                      {selected.name}
                    </span>
                    <button
                      className="text-button"
                      aria-label="改名"
                      onClick={() => {
                        if (!leaveEditing()) return;
                        setMode({ kind: 'renaming', id: selected.id, name: selected.name });
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
                        setMode({
                          kind: 'editing',
                          id: selected.id,
                          prose: shown.prose ?? '',
                          steps: shown.steps,
                          dirty: false,
                        });
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
                    <FolderOpen size={16} />
                    {revealLabel(navigator.userAgent)}
                  </button>
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={async () => {
                      if (!window.confirm(`删除「${selected.name}」？轨迹文件会一起删除。`)) return;
                      if (await run(() => window.pilion.skills.remove(selected.id))) setMode(VIEW);
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
                  <span>提炼未通过：{distilling.reason}</span>
                  <div className="distill-banner-actions">
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
                </div>
              ) : null}
              {distilling?.status === 'proposed' ? (
                <>
                  <div className="distill-banner proposed">
                    <span>Agent 提炼好了，看一遍再决定</span>
                    <div className="distill-banner-actions">
                      <button
                        className="secondary-button"
                        // 保留会重写文件；编辑器里那份副本已经读过旧文件，留着它保存就把提炼盖回去了。
                        disabled={busy || Boolean(editing)}
                        title={editing ? '先保存或取消当前编辑' : undefined}
                        onClick={async () => {
                          // 保留把提炼写进这份录制自己的 skill.md，id 没变，effect 不会自己重读。
                          if (await run(() => window.pilion.skills.keep())) reload();
                        }}
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
                  id={editing.id}
                  busy={busy}
                  run={run}
                  prose={editing.prose}
                  setProse={(prose) => updateEditing((current) => ({ ...current, prose }))}
                  steps={editing.steps}
                  setSteps={(steps) => updateEditing((current) => ({ ...current, steps }))}
                  setDirty={(dirty) => updateEditing((current) => ({ ...current, dirty }))}
                  setEditing={(open) => {
                    if (!open)
                      setMode((current) =>
                        current.kind === 'editing' && current.id === editing.id ? VIEW : current,
                      );
                  }}
                  onCancel={leaveEditing}
                  reload={reload}
                />
              ) : (
                <>
                  {/* 提示记在技能库对象里，直到这份录制的详情被打开一次为止；打开详情本身
                      就是确认，所以只说一次。取 shown（这次详情响应）而不是 selected（列表
                      摘要）：确认之后列表会跟着刷新，selected.recomputed 跟着变 false，这句
                      话来自 shown 就不会跟着列表一起消失。 */}
                  {shown?.recomputed ? (
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
                  {activeTab !== 'process' && detailError ? (
                    <p className="skills-error">技能内容读不出来：{detailError}</p>
                  ) : activeTab !== 'process' && !shown ? (
                    <p className="skills-note">加载中…</p>
                  ) : activeTab === 'steps' ? (
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
