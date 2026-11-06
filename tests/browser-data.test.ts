import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { browserRoot, discoverExtensions, ExtensionStore } from '../src/main/browser/browser-data';
const directories: string[] = [];
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'pilion-extension-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function extension(root: string, version: string) {
  const path = join(root, 'Extensions', 'a'.repeat(32), version);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Fixture',
      version: version.split('_')[0],
      content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }],
    }),
  );
  await writeFile(join(path, 'content.js'), 'document.body.dataset.extension = "yes"');
  return path;
}
test('discovers newest valid installed extension version numerically', async () => {
  const root = await scratch();
  await extension(root, '1.9_0');
  await extension(root, '1.10_0');
  const found = await discoverExtensions(root);
  expect(found).toHaveLength(1);
  expect(found[0].path).toContain('1.10_0');
});
test('copies extensions, deduplicates reimport and restores enabled state', async () => {
  const root = await scratch();
  const source = await extension(root, '1.0_0');
  const loaded: string[] = [];
  const api = {
    loadExtension: async (path: string) => {
      loaded.push(path);
      return { id: 'fixture', name: 'Fixture', version: '1.0' };
    },
    removeExtension: () => {},
  };
  const storage = join(root, 'managed');
  const store = new ExtensionStore(storage, api);
  await store.restore();
  await store.install(source, 'chrome:Default:fixture');
  await store.install(source, 'chrome:Default:fixture');
  expect(store.list()).toHaveLength(1);
  expect(loaded[0]).toContain('managed');
  await rm(source, { recursive: true });
  expect(await readFile(join(loaded[0], 'content.js'), 'utf8')).toContain('dataset');
  await store.toggle(store.list()[0].id, false);
  const restored = new ExtensionStore(storage, api);
  await restored.restore();
  expect(restored.list()[0].enabled).toBe(false);
  await restored.remove(restored.list()[0].id);
  expect(restored.list()).toEqual([]);
});
test('rejects symbolic links in extension code', async () => {
  const root = await scratch();
  const source = await extension(root, '1.0_0');
  await symlink('/etc/passwd', join(source, 'linked'));
  const store = new ExtensionStore(join(root, 'managed'), {
    loadExtension: async () => ({ id: 'x', name: 'X', version: '1' }),
    removeExtension: () => {},
  });
  await expect(store.install(source, 'fixture')).rejects.toThrow(/链接/);
  expect(store.list()).toEqual([]);
});
test('maps Chrome roots on each supported OS', () => {
  expect(browserRoot('chrome', 'darwin', '/home/me', '/local')).toBe(
    '/home/me/Library/Application Support/Google/Chrome',
  );
  expect(browserRoot('edge', 'win32', '/home/me', '/local')).toBe(
    '/local/Microsoft/Edge/User Data',
  );
  expect(browserRoot('brave', 'linux', '/home/me', '/local')).toBe(
    '/home/me/.config/BraveSoftware/Brave-Browser',
  );
});

test('serializes concurrent installs without losing either extension', async () => {
  const root = await scratch();
  const first = await extension(root, '1.0_0');
  const second = await extension(root, '2.0_0');
  const api = {
    loadExtension: async (path: string) => ({
      id: path.split('/').at(-1)!,
      name: 'Fixture',
      version: '1',
    }),
    removeExtension: () => {},
  };
  const store = new ExtensionStore(join(root, 'managed'), api);
  await Promise.all([store.install(first, 'first'), store.install(second, 'second')]);
  const restored = new ExtensionStore(join(root, 'managed'), api);
  await restored.restore();
  expect(restored.list()).toHaveLength(2);
});

test('rolls back a loaded extension when persistence fails', async () => {
  const root = await scratch();
  const source = await extension(root, '1.0_0');
  const storage = join(root, 'managed');
  await mkdir(join(storage, 'installed.json'), { recursive: true });
  const active = new Set<string>();
  const store = new ExtensionStore(storage, {
    loadExtension: async () => {
      active.add('fixture');
      return { id: 'fixture', name: 'Fixture', version: '1' };
    },
    removeExtension: (id) => {
      active.delete(id);
    },
  });
  await expect(store.install(source, 'first')).rejects.toThrow();
  expect(store.list()).toEqual([]);
  expect([...active]).toEqual([]);
});

test('malformed metadata leaves extension management usable', async () => {
  const root = await scratch();
  await writeFile(join(root, 'installed.json'), 'null');
  const store = new ExtensionStore(root, {
    loadExtension: async () => ({ id: 'x', name: 'X', version: '1' }),
    removeExtension: () => {},
  });
  await expect(store.restore()).rejects.toThrow('扩展配置无效');
  expect(store.list()).toEqual([]);
});

test('pinning survives restart and toggling without loading disabled extensions', async () => {
  const root = await scratch();
  const source = await extension(root, '1.0_0');
  let loads = 0;
  const api = {
    loadExtension: async () => {
      loads++;
      return { id: 'fixture', name: 'Fixture', version: '1' };
    },
    removeExtension: () => {},
  };
  const store = new ExtensionStore(join(root, 'managed'), api);
  await store.install(source, 'fixture');
  await store.pin('fixture', true);
  await store.toggle('fixture', false);
  const restored = new ExtensionStore(join(root, 'managed'), api);
  await restored.restore();
  expect(restored.list()[0]).toMatchObject({ pinned: true, enabled: false });
  expect(loads).toBe(1);
  await restored.pin('fixture', false);
  const again = new ExtensionStore(join(root, 'managed'), api);
  await again.restore();
  expect(again.list()[0].pinned).toBe(false);
});
