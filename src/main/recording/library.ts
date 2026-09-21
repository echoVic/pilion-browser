import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecordingSummary } from '../../shared/contracts.js';
import { parseSkill, parseTrajectory, serializeSkill, serializeTrajectory } from './format.js';
import type { Skill, Trajectory } from './types.js';

export type { RecordingSummary };

const FILE = 'trajectory.md';
const SKILL_FILE = 'skill.md';
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

function summarize(id: string, trajectory: Trajectory, skill?: Skill): RecordingSummary {
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
    await writeFile(`${target}.tmp`, serializeSkill(prose, skill), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  async list(): Promise<RecordingSummary[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const rows = await Promise.all(
      names.map(async (id) => {
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
            error: error instanceof Error ? error.message : String(error),
          } satisfies RecordingSummary;
        }
        try {
          const skill = (await this.hasSkill(id)) ? (await this.readSkill(id)).skill : undefined;
          return summarize(id, trajectory, skill);
        } catch (error) {
          // skill.md 坏了不该把轨迹一起藏起来：行照旧，只标出技能文件的问题。
          return {
            ...summarize(id, trajectory),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async read(id: string): Promise<{ trajectory: Trajectory; markdown: string }> {
    const markdown = await readFile(this.path(id), 'utf8');
    return { trajectory: parseTrajectory(markdown), markdown };
  }

  async write(id: string, trajectory: Trajectory): Promise<void> {
    return this.#serialize(() => this.#write(id, trajectory));
  }

  async #write(id: string, trajectory: Trajectory): Promise<void> {
    const target = this.path(id);
    await mkdir(join(this.root, id), { recursive: true, mode: 0o700 });
    await writeFile(`${target}.tmp`, serializeTrajectory(trajectory), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }

  async create(name: string, trajectory: Trajectory): Promise<string> {
    return this.#serialize(() => this.#create(name, trajectory));
  }

  async #create(name: string, trajectory: Trajectory): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const base = slugify(name);
    const taken = new Set(await readdir(this.root));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    await this.#write(id, { ...trajectory, meta: { ...trajectory.meta, name } });
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
