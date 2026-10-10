import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/main/settings-store';
import { AppSettingsPatchSchema } from '../src/shared/settings';
import { addressToUrl } from '../src/renderer/ui';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function settingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pilion-settings-'));
  directories.push(directory);
  return join(directory, 'settings.json');
}

describe('settings persistence', () => {
  it('starts from defaults that keep the old behaviour, theme left for the renderer to migrate', async () => {
    const store = new SettingsStore(await settingsPath());
    await store.load();
    expect(store.data).toEqual({
      startupBehavior: 'restore',
      searchEngine: 'google',
      quitOnWindowClose: true,
      agentWindowBehavior: 'foreground',
      autoUpdate: true,
    });
  });

  it('merges a partial update, writes it, and reads it back after a restart', async () => {
    const path = await settingsPath();
    const store = new SettingsStore(path);
    await store.load();
    await store.update({ theme: 'dark' });
    await store.update({ agentWindowBehavior: 'silent' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'dark',
      agentWindowBehavior: 'silent',
      searchEngine: 'google',
    });
    const restarted = new SettingsStore(path);
    await restarted.load();
    expect(restarted.data.theme).toBe('dark');
    expect(restarted.data.agentWindowBehavior).toBe('silent');
  });

  it('falls back field by field when the file was edited into something invalid', async () => {
    const path = await settingsPath();
    await writeFile(
      path,
      JSON.stringify({
        theme: 'purple',
        searchEngine: 'bing',
        quitOnWindowClose: 'no',
        autoUpdate: 'yes',
        extra: 1,
      }),
    );
    const store = new SettingsStore(path);
    await store.load();
    expect(store.data).toEqual({
      startupBehavior: 'restore',
      searchEngine: 'bing',
      quitOnWindowClose: true,
      agentWindowBehavior: 'foreground',
      autoUpdate: true,
    });
  });

  it('uses defaults when the file is not JSON at all', async () => {
    const path = await settingsPath();
    await writeFile(path, '{ not json');
    const store = new SettingsStore(path);
    await store.load();
    expect(store.data.searchEngine).toBe('google');
  });

  it('keeps auto-update on by default and remembers turning it off across a restart', async () => {
    const path = await settingsPath();
    const store = new SettingsStore(path);
    await store.load();
    expect(store.data.autoUpdate).toBe(true);
    await store.update({ autoUpdate: false });
    const restarted = new SettingsStore(path);
    await restarted.load();
    expect(restarted.data.autoUpdate).toBe(false);
  });

  it('accepts only known fields in an update and never fills in the ones not sent', () => {
    expect(AppSettingsPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' });
    expect(() => AppSettingsPatchSchema.parse({ downloadPath: '/tmp' })).toThrow();
    expect(() => AppSettingsPatchSchema.parse({ agentWindowBehavior: 'hidden' })).toThrow();
    expect(AppSettingsPatchSchema.parse({ autoUpdate: false })).toEqual({ autoUpdate: false });
    expect(() => AppSettingsPatchSchema.parse({ autoUpdate: 'no' })).toThrow();
  });
});

describe('address bar search engine', () => {
  it('searches with the chosen engine and leaves addresses alone', () => {
    expect(addressToUrl('pilion browser', 'duckduckgo')).toBe(
      'https://duckduckgo.com/?q=pilion%20browser',
    );
    expect(addressToUrl('pilion browser', 'bing')).toBe(
      'https://www.bing.com/search?q=pilion%20browser',
    );
    expect(addressToUrl('example.com', 'bing')).toBe('https://example.com');
  });
});
