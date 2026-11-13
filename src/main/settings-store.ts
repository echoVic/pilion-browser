import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AppSettingsSchema, type AppSettings, type AppSettingsPatch } from '../shared/settings.js';

export class SettingsStore {
  #data: AppSettings = AppSettingsSchema.parse({});
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  get data(): Readonly<AppSettings> {
    return this.#data;
  }

  /** 读不出来就用默认值：设置不像工作区，丢了可以重选，不值得因此拦住启动。 */
  async load(): Promise<void> {
    try {
      this.#data = AppSettingsSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('设置文件读取失败，使用默认设置', error);
    }
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    return this.#update(patch);
  }

  async setDownloadDirectory(downloadDirectory: string | undefined): Promise<AppSettings> {
    return this.#update({ downloadDirectory });
  }

  async #update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.#data = AppSettingsSchema.parse({ ...this.#data, ...patch });
    const body = JSON.stringify(this.#data, null, 2);
    this.#pending = this.#pending
      .catch(() => undefined)
      .then(async () => {
        // 临时文件名每次都不一样，两个写入者不会截断对方写了一半的文件；失败时删掉，不留孤儿。
        const temp = `${this.path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, body, { mode: 0o600 });
          await rename(temp, this.path);
        } catch (error) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    await this.#pending;
    return this.#data;
  }
}
