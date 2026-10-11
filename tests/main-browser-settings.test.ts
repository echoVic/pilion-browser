import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);

function mainFunctions(names: string[], context: Record<string, unknown>) {
  const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text),
  );
  expect(functions).toHaveLength(names.length);
  runInNewContext(
    ts.transpileModule(functions.map((node) => node.getText(source)).join('\n'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return context;
}

it('keeps pause and resume working for an active download after its folder is no longer allowed', () => {
  let paused = false;
  const item = {
    isPaused: () => paused,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
  const record = {
    id: 'active',
    savePath: '/old/file.txt',
    filename: 'file.txt',
    status: 'progressing',
  };
  const emit = vi.fn();
  let toggle: ((value: { id: string }) => void) | undefined;
  const stub = () => {};
  const context = new Proxy<Record<string, unknown>>(
    {
      IPC: { downloadTogglePause: 'toggle' },
      ipcMain: { handle: stub, on: stub },
      handle: (key: string, _schema: unknown, fn: (value: { id: string }) => void) => {
        if (key === 'toggle') toggle = fn;
      },
      activeDownloads: new Map([[record.id, item]]),
      workspace: { data: { downloads: [record] } },
      settings: { data: { downloadDirectory: '/new' } },
      app: { getPath: () => '/Downloads' },
      isDownloadPathAllowed: () => false,
      emit,
      Error,
    },
    {
      get(target, key) {
        return key in target ? target[key as string] : stub;
      },
    },
  );
  mainFunctions(['registerIpc', 'requireDownloadRecord', 'requireDownload'], context);
  (context.registerIpc as () => void)();
  expect(toggle).toBeDefined();
  expect(() => toggle!({ id: record.id })).not.toThrow();
  expect(record.status).toBe('paused');
  expect(() => toggle!({ id: record.id })).not.toThrow();
  expect(record.status).toBe('progressing');
  expect(emit).toHaveBeenCalledTimes(2);
});

it('parents the download picker to its caller, saves and broadcasts only a validated choice', async () => {
  const parent = {};
  const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/custom'] }));
  const setDownloadDirectory = vi.fn(async () => {});
  const assertDownloadDirectory = vi.fn();
  const broadcast = vi.fn();
  const context = mainFunctions(['chooseDownloadDirectory'], {
    dialog: { showOpenDialog },
    settings: { setDownloadDirectory },
    assertDownloadDirectory,
    broadcast,
  });
  const choose = context.chooseDownloadDirectory as (parent: object) => Promise<void>;
  await choose(parent);
  expect(showOpenDialog).toHaveBeenCalledWith(
    parent,
    expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
  );
  expect(assertDownloadDirectory).toHaveBeenCalledWith('/custom');
  expect(setDownloadDirectory).toHaveBeenCalledWith('/custom');
  expect(broadcast).toHaveBeenCalledOnce();
  showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  await choose(parent);
  expect(setDownloadDirectory).toHaveBeenCalledOnce();
  assertDownloadDirectory.mockImplementationOnce(() => {
    throw new Error('不可写');
  });
  await expect(choose(parent)).rejects.toThrow('不可写');
  expect(setDownloadDirectory).toHaveBeenCalledOnce();
});

it('uses the configured folder and logs an invalid-folder fallback once per download despite name collisions', () => {
  const log = vi.fn();
  const validate = vi.fn();
  const context = mainFunctions(['availableDownloadPath'], {
    app: { getPath: () => '/Downloads' },
    settings: { data: { downloadDirectory: '/custom' } },
    workspace: { data: { downloads: [{ savePath: '/Downloads/file.txt' }] } },
    assertDownloadDirectory: validate,
    basename,
    extname,
    join,
    existsSync: () => false,
    log,
  });
  const path = context.availableDownloadPath as (filename: string) => string;
  expect(path('../file.txt')).toBe('/custom/file.txt');
  expect(log).not.toHaveBeenCalled();
  validate.mockImplementation(() => {
    throw new Error('不可写');
  });
  expect(path('file.txt')).toBe('/Downloads/file (1).txt');
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toContain('系统下载目录');
  expect(path('file.txt')).toBe('/Downloads/file (1).txt');
  expect(log).toHaveBeenCalledTimes(2);
});

it('resets the directory through the main-owned store and broadcasts the change', async () => {
  const setDownloadDirectory = vi.fn(async () => {});
  const broadcast = vi.fn();
  const context = mainFunctions(['resetDownloadDirectory'], {
    settings: { setDownloadDirectory },
    broadcast,
  });
  await (context.resetDownloadDirectory as () => Promise<void>)();
  expect(setDownloadDirectory).toHaveBeenCalledWith(undefined);
  expect(broadcast).toHaveBeenCalledOnce();
});

it('reports records from a former directory as outside the current download location', () => {
  const record = { id: 'old', savePath: '/old/file.txt', filename: 'file.txt' };
  const context = mainFunctions(['requireDownloadRecord', 'requireDownload'], {
    workspace: { data: { downloads: [record] } },
    settings: { data: { downloadDirectory: '/custom' } },
    app: { getPath: () => '/Downloads' },
    basename,
    dirname: () => '/old',
    isDownloadPathAllowed: () => false,
  });
  expect(() => (context.requireDownload as (id: string) => unknown)('old')).toThrow(
    '文件不在当前下载位置',
  );
});

function clearing(response: number) {
  const parent = {};
  const history = [{ url: 'https://example.com' }];
  const downloads = ['completed', 'progressing', 'paused', 'cancelled', 'interrupted'].map(
    (status) => ({ status }),
  );
  const webSession = { clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}) };
  const defaultSession = { clearStorageData: vi.fn(), clearCache: vi.fn() };
  const fromPartition = vi.fn(() => webSession);
  const showMessageBox = vi.fn(async () => ({ response }));
  const emit = vi.fn();
  const workspace = { data: { history, downloads } };
  const context = mainFunctions(['clearHistory', 'clearDownloadRecords', 'clearBrowsingData'], {
    workspace,
    emit,
    session: { fromPartition, defaultSession },
    dialog: { showMessageBox },
  });
  const clear = context.clearBrowsingData as (
    input: { history: boolean; downloads: boolean; cookies: boolean; cache: boolean },
    parent: object,
  ) => Promise<{ cleared: boolean }>;
  return {
    context,
    parent,
    history,
    downloads,
    workspace,
    webSession,
    defaultSession,
    fromPartition,
    showMessageBox,
    emit,
    clear,
  };
}

it('cancelling the native confirmation leaves browsing data and sessions untouched', async () => {
  const test = clearing(1);
  expect(
    await test.clear({ history: true, downloads: true, cookies: true, cache: true }, test.parent),
  ).toEqual({ cleared: false });
  expect(test.showMessageBox).toHaveBeenCalledWith(
    test.parent,
    expect.objectContaining({
      buttons: ['清除', '取消'],
      defaultId: 1,
      cancelId: 1,
      detail: expect.stringContaining('Agent'),
    }),
  );
  expect(test.workspace.data.history).toEqual(test.history);
  expect(test.workspace.data.downloads).toEqual(test.downloads);
  expect(test.fromPartition).not.toHaveBeenCalled();
  expect(test.emit).not.toHaveBeenCalled();
});

it('clears chosen data only in the web partition and retains active downloads without deleting files', async () => {
  const test = clearing(0);
  expect(
    await test.clear({ history: true, downloads: true, cookies: true, cache: true }, test.parent),
  ).toEqual({ cleared: true });
  expect(test.workspace.data.history).toEqual([]);
  expect(test.workspace.data.downloads.map((item) => item.status)).toEqual([
    'progressing',
    'paused',
  ]);
  expect(test.fromPartition).toHaveBeenCalledWith('persist:pilion-default');
  expect(test.webSession.clearStorageData).toHaveBeenCalledWith();
  expect(test.webSession.clearCache).toHaveBeenCalledOnce();
  expect(test.defaultSession.clearStorageData).not.toHaveBeenCalled();
  expect(test.defaultSession.clearCache).not.toHaveBeenCalled();
});

it('history-only clearing leaves downloads and website storage alone and omits the sign-out warning', async () => {
  const test = clearing(0);
  await test.clear({ history: true, downloads: false, cookies: false, cache: false }, test.parent);
  expect(test.workspace.data.history).toEqual([]);
  expect(test.workspace.data.downloads).toEqual(test.downloads);
  expect(test.fromPartition).not.toHaveBeenCalled();
  expect(test.showMessageBox.mock.calls[0]).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('退出') })]),
  );
});

it('registers the three browser settings channels for trusted preferences frames and shares list clearing', () => {
  const calls: { key: string; schema: unknown; fn: unknown; options: unknown }[] = [];
  const stub = () => {};
  const keys = [
    'downloadChooseDirectory',
    'downloadResetDirectory',
    'browsingDataClear',
    'downloadClear',
    'historyClear',
  ];
  // 不执行其他 IPC 的回调，只检查真正注册的通道、schema 与权限。
  const context = new Proxy<Record<string, unknown>>(
    {
      IPC: Object.fromEntries(keys.map((key) => [key, key])),
      handle: (key: string, schema: unknown, fn: unknown, options: unknown) =>
        calls.push({ key, schema, fn, options }),
      clearHistory: stub,
      clearDownloadRecords: stub,
      BrowsingDataClearSchema: { marker: true },
      ipcMain: { handle: stub, on: stub },
    },
    {
      get(target, key) {
        return key in target ? target[key as string] : stub;
      },
    },
  );
  mainFunctions(['registerIpc'], context);
  (context.registerIpc as () => void)();
  for (const key of keys.slice(0, 3)) {
    expect(calls.find((call) => call.key === key)?.options).toEqual({ preferences: true });
  }
  expect(calls.find((call) => call.key === 'browsingDataClear')?.schema).toBe(
    context.BrowsingDataClearSchema,
  );
  expect(calls.find((call) => call.key === 'downloadClear')?.fn).toBe(stub);
  expect(calls.find((call) => call.key === 'historyClear')?.fn).toBe(stub);
});
