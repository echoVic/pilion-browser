import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../host/canonical.js';
import type { RecordingSummary } from '../../shared/contracts.js';
import {
  parseEvents,
  parseSkill,
  parseTrajectory,
  serializeEvents,
  serializeSkill,
  serializeTrajectory,
} from './format.js';
import { project } from './project.js';
import type { LoggedEvent, Skill, Trajectory } from './types.js';

export type { RecordingSummary };

const FILE = 'trajectory.md';
const SKILL_FILE = 'skill.md';
const EVENTS_FILE = 'events.jsonl';
const ID_PATTERN = /^[\p{L}\p{N}-]{1,60}$/u;

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'recording';
}

function assertId(id: string): void {
  if (!ID_PATTERN.test(id) || id === '.' || id === '..') throw new Error(`不合法的录制 id：${id}`);
}

/** 临时文件名必须每次唯一：自愈写入不走队列，与排队的写入撞在同一个 .tmp 上会让输的一方 rename 报 ENOENT。 */
function tempPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

function summarize(
  id: string,
  trajectory: Trajectory,
  hasEvents: boolean,
  skill?: Skill,
): RecordingSummary {
  const steps = skill
    ? skill.steps.map((step) => ({ step, unsupported: undefined }))
    : trajectory.entries.flatMap((entry) => (entry.kind === 'step' ? [entry] : []));
  return {
    id,
    name: skill?.meta.name ?? trajectory.meta.name,
    steps: steps.length,
    unsupported: steps.filter((entry) => entry.unsupported).length,
    needsHuman: steps.filter((entry) => entry.step.kind === 'human').length,
    recordedAt: trajectory.meta.recordedAt,
    distilled: Boolean(skill),
    hasEvents,
    ...(skill ? { about: skill.meta.about } : {}),
  };
}

/** 一份录制一个目录；只有 Pilion 与人写得进来，Agent 只能通过第二期的 MCP 工具读与播。 */
export class RecordingLibrary {
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  /** 与 WorkspaceStore 同款：所有写操作排队，create 的查重与写入之间不会插进别的写。 */
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#pending.catch(() => undefined).then(operation);
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  path(id: string): string {
    assertId(id);
    return join(this.root, id, FILE);
  }

  skillPath(id: string): string {
    assertId(id);
    return join(this.root, id, SKILL_FILE);
  }

  eventsPath(id: string): string {
    assertId(id);
    return join(this.root, id, EVENTS_FILE);
  }

  /** 没有日志是正常状态（第一期的老录制），读不到就是 undefined，不当错误处理。 */
  async #readEventsText(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.eventsPath(id), 'utf8');
    } catch {
      return undefined;
    }
  }

  async readEvents(id: string): Promise<LoggedEvent[] | undefined> {
    const text = await this.#readEventsText(id);
    return text === undefined ? undefined : parseEvents(text);
  }

  async hasSkill(id: string): Promise<boolean> {
    try {
      await stat(this.skillPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async readSkill(id: string): Promise<{ prose: string; skill: Skill; markdown: string }> {
    const markdown = await readFile(this.skillPath(id), 'utf8');
    return { ...parseSkill(markdown), markdown };
  }

  /** 与轨迹一样走写队列、临时文件与 0o600；散文原样、块按规范形式。 */
  async writeSkill(id: string, prose: string, skill: Skill): Promise<void> {
    return this.#serialize(() => this.#writeSkill(id, prose, skill));
  }

  async #writeSkill(id: string, prose: string, skill: Skill): Promise<void> {
    const target = this.skillPath(id);
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
    const temp = tempPath(target);
    await writeFile(temp, serializeSkill(prose, skill), { mode: 0o600 });
    await rename(temp, target);
  }

  async list(): Promise<RecordingSummary[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const rows = await Promise.all(
      names.map(async (id) => {
        // read() 已经会去读一次日志文本来判断要不要重算，这里单独再读一次而不是
        // 让 read() 带出这个信息：多读几十 KB 的文件不值得为此改 read() 的返回形状。
        const hasEvents = (await this.#readEventsText(id)) !== undefined;
        let trajectory: Trajectory;
        try {
          trajectory = (await this.read(id)).trajectory;
        } catch (error) {
          return {
            id,
            name: id,
            steps: 0,
            unsupported: 0,
            needsHuman: 0,
            recordedAt: '',
            distilled: false,
            hasEvents,
            error: error instanceof Error ? error.message : String(error),
          } satisfies RecordingSummary;
        }
        try {
          const skill = (await this.hasSkill(id)) ? (await this.readSkill(id)).skill : undefined;
          return summarize(id, trajectory, hasEvents, skill);
        } catch (error) {
          // skill.md 坏了不该把轨迹一起藏起来：行照旧，只标出技能文件的问题。
          return {
            ...summarize(id, trajectory, hasEvents),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  /**
   * 没有日志就是第一期的老录制：md 里的步骤就是全部真相，不动它。
   * 有日志时比对两个哈希：日志的和 entries 数组自己的，两个都对得上才照旧返回；
   * 任何一个对不上都说明轨迹或日志被单独动过，日志赢，按它重算并把 md 改写回去，
   * 好让下一次读取不用再重算一遍。只查日志哈希查不出「entries 被单独手改」这种
   * 篡改——改这个文件的步骤块从不触碰 events.jsonl，日志哈希原地不动。
   * entriesHash 缺失（旧版 v2 轨迹）当一种不合处理，同样触发一次重算自愈。
   *
   * entries 的哈希只对解析出来的数组算，不重新投影整份日志去比——那样每次
   * list() 都要为每份录制重放全部事件，两万条的日志会让这一步单独变成大头。
   *
   * 改写调用的是 #write 而不是排队的 write：read() 会被 #rename 这类已经在
   * 队列里执行的操作再次调用，如果这里又去抢同一条队列，队列会在等待自己，
   * 永远排不到——是真死锁，不是理论风险（加一条 rename 加重算的用例就会 5s 超时）。
   * 两次重算从同一份日志算出的字节完全相同，绕开队列不会撕裂写入，只是把「这个
   * id 同时还有别的写在跑」的极小概率窗口，换成了「保证不会卡死整条队列」。
   */
  async read(
    id: string,
  ): Promise<{ trajectory: Trajectory; markdown: string; recomputed: boolean }> {
    const markdown = await readFile(this.path(id), 'utf8');
    const trajectory = parseTrajectory(markdown);
    const text = await this.#readEventsText(id);
    if (text === undefined) return { trajectory, markdown, recomputed: false };
    const hash = sha256(text);
    const entriesHash = sha256(trajectory.entries);
    const source = trajectory.meta.source;
    if (source?.hash === hash && source?.entriesHash === entriesHash)
      return { trajectory, markdown, recomputed: false };
    const events = parseEvents(text);
    const entries = project(events).entries;
    const rebuilt: Trajectory = {
      meta: {
        ...trajectory.meta,
        version: 2,
        source: { events: events.length, hash, entriesHash: sha256(entries) },
      },
      entries,
    };
    await this.#write(id, rebuilt);
    return { trajectory: rebuilt, markdown: serializeTrajectory(rebuilt), recomputed: true };
  }

  async write(id: string, trajectory: Trajectory, events?: readonly LoggedEvent[]): Promise<void> {
    return this.#serialize(() => this.#write(id, trajectory, events));
  }

  /**
   * 先写日志再写轨迹：中途失败留下「日志比轨迹新」，下次读取会自愈重算；
   * 反过来则会留下一份没有依据的轨迹。events 缺省时只改轨迹，日志不因此变化
   * （比如改名：日志不因为改名而变）。
   */
  async #write(id: string, trajectory: Trajectory, events?: readonly LoggedEvent[]): Promise<void> {
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
    if (events) {
      const target = this.eventsPath(id);
      const temp = tempPath(target);
      await writeFile(temp, serializeEvents(events), { mode: 0o600 });
      await rename(temp, target);
    }
    const target = this.path(id);
    const temp = tempPath(target);
    await writeFile(temp, serializeTrajectory(trajectory), { mode: 0o600 });
    await rename(temp, target);
  }

  async create(
    name: string,
    trajectory: Trajectory,
    events?: readonly LoggedEvent[],
  ): Promise<string> {
    return this.#serialize(() => this.#create(name, trajectory, events));
  }

  async #create(
    name: string,
    trajectory: Trajectory,
    events?: readonly LoggedEvent[],
  ): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const base = slugify(name);
    const taken = new Set(await readdir(this.root));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    // 传了 events 就是第二期起的录制：meta 指向这份日志和当下的 entries，往后 read() 靠它们判断要不要重算。
    const meta = events
      ? {
          ...trajectory.meta,
          version: 2 as const,
          source: {
            events: events.length,
            hash: sha256(serializeEvents(events)),
            entriesHash: sha256(trajectory.entries),
          },
        }
      : trajectory.meta;
    await this.#write(id, { ...trajectory, meta: { ...meta, name } }, events);
    return id;
  }

  async rename(id: string, name: string): Promise<void> {
    return this.#serialize(() => this.#rename(id, name));
  }

  /** 列表与详情都优先认 skill.md 里的名字，只改轨迹等于没改，所以两份一起改。 */
  async #rename(id: string, name: string): Promise<void> {
    const { trajectory } = await this.read(id);
    // 两份都先读出来：skill.md 坏掉时整次改名原地失败，不会留下一半改过的名字。
    const distilled = (await this.hasSkill(id)) ? await this.readSkill(id) : undefined;
    await this.#write(id, { ...trajectory, meta: { ...trajectory.meta, name } });
    if (distilled)
      await this.#writeSkill(id, distilled.prose, {
        ...distilled.skill,
        meta: { ...distilled.skill.meta, name },
      });
  }

  async remove(id: string): Promise<void> {
    return this.#serialize(() => this.#remove(id));
  }

  async #remove(id: string): Promise<void> {
    assertId(id);
    await rm(join(this.root, id), { recursive: true, force: true });
  }
}
