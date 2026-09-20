import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Clapperboard, FolderOpen, Pencil, Play, Trash, TriangleAlert } from 'lucide-react';
import type { RecordingSummary, SkillDetail } from '../shared/contracts';

type Props = {
  skills: RecordingSummary[];
  busy: boolean;
  run(action: () => Promise<unknown>): Promise<unknown>;
  /** 播放前切回网页视图，蒙层与回放条在那里。 */
  onPlay(id: string): void;
};

export function SkillLibrary({ skills, busy, run, onPlay }: Props) {
  const [selectedId, setSelectedId] = useState<string | undefined>(skills[0]?.id);
  const [detail, setDetail] = useState<SkillDetail | undefined>();
  const [tab, setTab] = useState<'steps' | 'trajectory'>('steps');
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [name, setName] = useState('');
  const selected = skills.find((item) => item.id === selectedId) ?? skills[0];
  // 改名表单绑在它打开时的那一行上。删除会让 selected 落到另一行，那时表单必须自己收起来，
  // 否则「保存」会去改一个人根本没点改名的技能。
  const renaming = selected !== undefined && renamingId === selected.id;

  // The loaded detail is matched to the selected row by id rather than cleared on switch, so a
  // row never borrows the previous row's steps while its own read is still in flight.
  const shown = selected && !selected.error && detail?.id === selected.id ? detail : undefined;

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
                      }
                    }}
                  >
                    <Trash size={16} />
                    删除
                  </button>
                </div>
              </header>
              {selected.error ? (
                <p className="skills-error">{selected.error}</p>
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
                    <ol className="skills-steps">
                      {shown?.steps.map((step) => (
                        <li
                          key={step.index}
                          className={
                            step.unsupported ? 'unsupported' : step.ambiguous ? 'ambiguous' : ''
                          }
                        >
                          <span className="step-index">{step.index}</span>
                          <span className="step-text">{step.text}</span>
                          {step.unsupported ? (
                            <span className="step-mark">回放不了：{step.unsupported}</span>
                          ) : null}
                          {step.ambiguous ? (
                            <span className="step-mark">录制时目标描述不唯一</span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
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
