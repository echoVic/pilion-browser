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
/** 清扫临时文件的年龄阈值：进行中的写入只持续几毫秒，十分钟前还在的 .tmp 必然是崩溃留下的孤儿。 */
const TEMP_FILE_TTL_MS = 10 * 60 * 1000;

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
  recomputed: boolean,
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
    ...(recomputed ? { recomputed: true } : {}),
    ...(skill ? { about: skill.meta.about } : {}),
  };
}

/** 一份录制一个目录；只有 Pilion 与人写得进来，Agent 只能通过第二期的 MCP 工具读与播。 */
export class RecordingLibrary {
  #pending: Promise<void> = Promise.resolve();

  /**
   * 重算过、还没让人看过详情的 id。list() 对集合里的 id 一直报 recomputed: true，
   * 与那一次 list() 或 read() 有没有真的重算无关；acknowledgeRecompute() 把 id 移出。
   * 只存在内存里：应用重启后提示消失是可以接受的——重算只在读取时发生，重启前人有
   * 整个会话的时间看到它。
   */
  #pendingRecompute = new Set<string>();

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

  /**
   * 没有日志是正常状态（第一期的老录制）：只有「文件不存在」算没有日志，读到 undefined。
   * 权限不足、路径变成了目录这类其它错误不能悄悄降级成「没有日志」——那会让一份有日志的
   * 录制被当成老录制，既跳过手改检测，过程视图也显示成空，看不出发生过什么；所以在这里
   * 就以中文说明抛出，交给 read()、list() 和 requireEvents() 各自的错误处理去接。
   */
  async #readEventsText(id: string): Promise<string | undefined> {
    try {
      return await readFile(this.eventsPath(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error(`读不出过程记录：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }

  async readEvents(id: string): Promise<LoggedEvent[] | undefined> {
    const text = await this.#readEventsText(id);
    return text === undefined ? undefined : parseEvents(text);
  }

  /**
   * 过程视图专用：日志缺不缺都不能显示成一份空列表，缺了就直接报错，由过程视图把原因
   * 显示出来（第三期 Task 9 已经接好这条路）。readEvents()「没有就是 undefined」的语义
   * 不能因为这个方法改变——提炼靠它区分新老录制，见 startDistillation()。
   */
  async requireEvents(id: string): Promise<LoggedEvent[]> {
    const events = await this.readEvents(id);
    if (events === undefined) throw new Error('找不到这份录制的过程记录，文件可能已被删除或移走');
    return events;
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
        // 日志读不出（权限不对、路径变成了目录……）现在和轨迹本身读不出一样会抛错，
        // 两步放进同一个 try：hasEvents 保留抛错前已经读到的值，一开始就抛错时是 false。
        let hasEvents = false;
        let trajectory: Trajectory;
        try {
          hasEvents = (await this.#readEventsText(id)) !== undefined;
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
        // read() 在这里就把手改覆盖掉了，但这不是人唯一能被告知的时刻：id 只要还在
        // #pendingRecompute 里就一直报 true，跟这一次 read() 有没有真的重算无关——
        // 上面这次调用如果真的重算过，也已经把 id 加进了那个集合。
        const recomputed = this.#pendingRecompute.has(id);
        try {
          const skill = (await this.hasSkill(id)) ? (await this.readSkill(id)).skill : undefined;
          return summarize(id, trajectory, hasEvents, recomputed, skill);
        } catch (error) {
          // skill.md 坏了不该把轨迹一起藏起来：行照旧，只标出技能文件的问题。
          return {
            ...summarize(id, trajectory, hasEvents, recomputed),
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
   *
   * 这次调用是否重算，返回值里如实照报；但「人有没有被告知过」是另一件事，记在
   * #pendingRecompute 里，见 acknowledgeRecompute()。
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
    // 人被覆盖掉的手改记在这里，直到 acknowledgeRecompute(id) 确认掉为止——
    // list() 就是靠这个集合，把提示带过后面那些没有再重算的列表。
    this.#pendingRecompute.add(id);
    return { trajectory: rebuilt, markdown: serializeTrajectory(rebuilt), recomputed: true };
  }

  /**
   * 看过一次详情就算告知过：skillDetail 在把这份录制的重算提示交给人之后调用它。
   * id 不在集合里（包括压根没有这个录制）什么也不做，返回 false。
   */
  acknowledgeRecompute(id: string): boolean {
    return this.#pendingRecompute.delete(id);
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
    // 同名再建会拿回这个 id：没看过的重算提示随录制一起删掉，不留给以后那份新录制。
    this.#pendingRecompute.delete(id);
  }

  /**
   * 清掉写入在临时文件与 rename 之间崩溃留下的孤儿：应用没有单实例锁，两个实例可能
   * 同时各写各的 .tmp，进行中的写入只持续几毫秒，所以只清早于阈值（十分钟）的——
   * 新鲜的 .tmp 有可能正被另一个实例写着，动不得。只删 readdir 认定为普通文件、
   * 名字以 .tmp 结尾的条目：目录、符号链接一律跳过，不当文件删，也不会顺着链接追
   * 下去，只在识别为录制目录（目录名合法）的子目录里找，根目录自己的文件不碰。
   * 单个录制目录或单个文件出问题（比如扫描期间撞上并发的 remove()）只跳过那一个，
   * 不连累其它录制；根目录还不存在（还没录过东西）什么也不做，不算错误——调用方
   * 在启动时调用一次，其它读不出根目录的原因原样抛出，是否记日志由调用方决定。
   */
  async sweepStaleTempFiles(now: number = Date.now()): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(names.map((id) => this.#sweepRecordingDir(id, now)));
  }

  async #sweepRecordingDir(id: string, now: number): Promise<void> {
    const dir = join(this.root, id);
    let staleNames: string[];
    try {
      staleNames = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
        .map((entry) => entry.name);
    } catch {
      return; // 目录在扫描期间消失（比如撞上并发的 remove()），跳过不算错误。
    }
    await Promise.all(
      staleNames.map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (now - info.mtimeMs > TEMP_FILE_TTL_MS) await rm(path, { force: true });
        } catch {
          // 单个文件的状态读不出或删不掉（多半是另一个实例刚好也在清，或者写完了），
          // 不影响其它文件。
        }
      }),
    );
  }
}
