import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserId, ExtensionView } from '../../shared/contracts.js';

export const BROWSERS = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  chromium: 'Chromium',
} as const;
export function browserRoot(
  browser: BrowserId,
  platform: string,
  home: string,
  local: string,
): string {
  const folders = {
    darwin: {
      chrome: 'Google/Chrome',
      edge: 'Microsoft Edge',
      brave: 'BraveSoftware/Brave-Browser',
      chromium: 'Chromium',
    },
    win32: {
      chrome: 'Google/Chrome/User Data',
      edge: 'Microsoft/Edge/User Data',
      brave: 'BraveSoftware/Brave-Browser/User Data',
      chromium: 'Chromium/User Data',
    },
    linux: {
      chrome: 'google-chrome',
      edge: 'microsoft-edge',
      brave: 'BraveSoftware/Brave-Browser',
      chromium: 'chromium',
    },
  };
  if (platform === 'darwin')
    return join(home, 'Library/Application Support', folders.darwin[browser]);
  if (platform === 'win32') return join(local, folders.win32[browser]);
  return join(home, '.config', folders.linux[browser]);
}
export async function discoverExtensions(
  profile: string,
): Promise<{ id: string; name: string; path: string; version: string }[]> {
  const root = join(profile, 'Extensions');
  const found = [];
  for (const id of await readdir(root).catch(() => [] as string[])) {
    if (!/^[a-p]{32}$/.test(id)) continue;
    const versions = (await readdir(join(root, id))).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const version of versions) {
      try {
        const path = join(root, id, version);
        const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
        if (!manifest.name || !manifest.version || ![2, 3].includes(manifest.manifest_version))
          continue;
        found.push({ id, path, name: manifest.name, version: manifest.version });
        break;
      } catch {
        /* Skip incomplete installs. */
      }
    }
  }
  return found;
}
interface ExtensionApi {
  loadExtension(path: string): Promise<{ id: string; name: string; version: string }>;
  removeExtension(id: string): void;
}
interface Entry extends ExtensionView {
  source: string;
  folder: string;
}
async function assertNoLinks(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('扩展目录不能包含符号链接');
  if (info.isDirectory())
    for (const child of await readdir(path)) await assertNoLinks(join(path, child));
  else if (!info.isFile()) throw new Error('扩展目录包含不支持的文件');
}
async function extensionIcon(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const icons =
      manifest.action?.default_icon ?? manifest.browser_action?.default_icon ?? manifest.icons;
    const file =
      typeof icons === 'string'
        ? icons
        : (icons?.['32'] ?? icons?.['48'] ?? icons?.['16'] ?? Object.values(icons ?? {})[0]);
    if (typeof file !== 'string') return;
    const path = resolve(directory, file);
    if (!path.startsWith(resolve(directory) + sep)) return;
    const mime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
    };
    const type = mime[extname(path).toLowerCase()];
    if (!type || (await lstat(path)).size > 256 * 1024) return;
    return `data:${type};base64,${(await readFile(path)).toString('base64')}`;
  } catch {
    return undefined;
  }
}
/** Own copied code, so browser updates/removal cannot break the installed extension. */
export class ExtensionStore {
  private entries: Entry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  constructor(
    private root: string,
    private api: ExtensionApi,
  ) {}
  list(): ExtensionView[] {
    return this.entries.map(({ id, name, version, enabled, error, pinned, icon }) => ({
      id,
      name,
      version,
      enabled,
      error,
      pinned: pinned ?? false,
      icon,
    }));
  }
  private async save() {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, 'installed.json.tmp');
    await writeFile(temp, JSON.stringify(this.entries, null, 2));
    await rename(temp, join(this.root, 'installed.json'));
  }
  async restore() {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.root, 'installed.json'), 'utf8'));
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (entry) =>
            entry &&
            typeof entry.id === 'string' &&
            typeof entry.name === 'string' &&
            typeof entry.version === 'string' &&
            typeof entry.source === 'string' &&
            typeof entry.enabled === 'boolean' &&
            /^[\da-f-]{36}$/.test(entry.folder),
        )
      )
        throw new Error('扩展配置无效');
      this.entries = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const entry of this.entries) {
      entry.icon = await extensionIcon(join(this.root, entry.folder));
      if (!/^[\da-f-]{36}$/.test(entry.folder)) throw new Error('扩展配置目录无效');
      if (entry.enabled) {
        try {
          Object.assign(entry, await this.api.loadExtension(join(this.root, entry.folder)), {
            error: undefined,
          });
        } catch (error) {
          entry.error = String(error);
        }
      }
    }
  }
  install(path: string, source: string) {
    return this.serialize(() => this.installOne(path, source));
  }
  private async installOne(path: string, source: string) {
    const existing = this.entries.find((entry) => entry.source === source);
    if (existing) return existing;
    await assertNoLinks(path);
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    if (![2, 3].includes(manifest.manifest_version))
      throw new Error('仅支持 Manifest V2 / V3 扩展');
    const folder = randomUUID();
    const destination = join(this.root, folder);
    await mkdir(this.root, { recursive: true });
    try {
      await cp(path, destination, { recursive: true });
      const extension = await this.api.loadExtension(destination);
      const entry: Entry = {
        id: extension.id,
        name: extension.name,
        version: extension.version,
        enabled: true,
        pinned: false,
        icon: await extensionIcon(destination),
        folder,
        source,
      };
      const duplicate = this.entries.find((item) => item.id === extension.id);
      if (duplicate) {
        if (duplicate.enabled) await this.api.loadExtension(join(this.root, duplicate.folder));
        else this.api.removeExtension(extension.id);
        await rm(destination, { recursive: true, force: true });
        return duplicate;
      }
      this.entries.push(entry);
      try {
        await this.save();
      } catch (error) {
        this.entries = this.entries.filter((item) => item !== entry);
        this.api.removeExtension(entry.id);
        throw error;
      }
      return entry;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
  pin(id: string, pinned: boolean) {
    return this.serialize(async () => {
      const entry = this.entries.find((entry) => entry.id === id);
      if (!entry) throw new Error('未找到扩展');
      const previous = entry.pinned;
      entry.pinned = pinned;
      try {
        await this.save();
      } catch (error) {
        entry.pinned = previous;
        throw error;
      }
    });
  }
  toggle(id: string, enabled: boolean) {
    return this.serialize(() => this.toggleOne(id, enabled));
  }
  private async toggleOne(id: string, enabled: boolean) {
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry) throw new Error('未找到扩展');
    const previous = { ...entry };
    if (enabled) Object.assign(entry, await this.api.loadExtension(join(this.root, entry.folder)));
    else this.api.removeExtension(entry.id);
    entry.enabled = enabled;
    entry.error = undefined;
    try {
      await this.save();
    } catch (error) {
      Object.assign(entry, previous);
      if (previous.enabled && !previous.error)
        await this.api.loadExtension(join(this.root, entry.folder));
      else this.api.removeExtension(entry.id);
      throw error;
    }
  }
  remove(id: string) {
    return this.serialize(() => this.removeOne(id));
  }
  private async removeOne(id: string) {
    const entry = this.entries.find((entry) => entry.id === id);
    if (!entry) return;
    const previous = this.entries;
    this.entries = this.entries.filter((item) => item !== entry);
    try {
      await this.save();
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    this.api.removeExtension(entry.id);
    await rm(join(this.root, entry.folder), { recursive: true, force: true });
  }
}
