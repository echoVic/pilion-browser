import { readFile, rename, writeFile } from 'node:fs/promises';
import { app } from 'electron';
import { join } from 'node:path';
import { z } from 'zod';

export const AppSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'auto']).default('auto'),
  startupBehavior: z.enum(['restore', 'new']).default('restore'),
  searchEngine: z.enum(['google', 'bing', 'duckduckgo']).default('google'),
  downloadPath: z.string().optional(),
  downloadPrompt: z.boolean().default(false),
  quitOnWindowClose: z.boolean().default(false),
  agentWindowBehavior: z.enum(['foreground', 'silent']).default('foreground'),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const SEARCH_ENGINES: Record<
  NonNullable<AppSettings['searchEngine']>,
  { name: string; url: string }
> = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};

export class SettingsStore {
  #data: AppSettings = AppSettingsSchema.parse({});
  #pending: Promise<void> = Promise.resolve();
  readonly #path: string;

  constructor(path?: string) {
    this.#path = path ?? join(app.getPath('userData'), 'settings.json');
  }

  get data(): Readonly<AppSettings> {
    return this.#data;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#data = AppSettingsSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Settings load failed, using defaults:', error);
      }
      // Defaults are already set; just keep them.
    }
  }

  update(patch: Partial<AppSettings>): void {
    this.#data = AppSettingsSchema.parse({ ...this.#data, ...patch });
  }

  save(): Promise<void> {
    const body = JSON.stringify(this.#data, null, 2);
    this.#pending = this.#pending.catch(() => undefined).then(async () => {
      await writeFile(`${this.#path}.tmp`, body, { mode: 0o600 });
      await rename(`${this.#path}.tmp`, this.#path);
    });
    return this.#pending;
  }
}
