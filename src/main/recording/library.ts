import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTrajectory, serializeTrajectory } from './format.js';
import type { Trajectory } from './types.js';

export interface RecordingSummary {
  id: string;
  name: string;
  steps: number;
  unsupported: number;
  needsHuman: number;
  recordedAt: string;
  /** 文件读不出来时的原因；有它的行不能播放，但仍然列出来让人去修。 */
  error?: string;
}

const FILE = 'trajectory.md';
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

function summarize(id: string, trajectory: Trajectory): RecordingSummary {
  const steps = trajectory.entries.filter((entry) => entry.kind === 'step');
  return {
    id,
    name: trajectory.meta.name,
    steps: steps.length,
    unsupported: steps.filter((entry) => entry.unsupported).length,
    needsHuman: steps.filter((entry) => entry.step.kind === 'human').length,
    recordedAt: trajectory.meta.recordedAt,
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

  async list(): Promise<RecordingSummary[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const rows = await Promise.all(
      names.map(async (id) => {
        try {
          return summarize(id, (await this.read(id)).trajectory);
        } catch (error) {
          return {
            id,
            name: id,
            steps: 0,
            unsupported: 0,
            needsHuman: 0,
            recordedAt: '',
            error: error instanceof Error ? error.message : String(error),
          } satisfies RecordingSummary;
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

  async #rename(id: string, name: string): Promise<void> {
    const { trajectory } = await this.read(id);
    await this.#write(id, { ...trajectory, meta: { ...trajectory.meta, name } });
  }

  async remove(id: string): Promise<void> {
    return this.#serialize(() => this.#remove(id));
  }

  async #remove(id: string): Promise<void> {
    assertId(id);
    await rm(join(this.root, id), { recursive: true, force: true });
  }
}
