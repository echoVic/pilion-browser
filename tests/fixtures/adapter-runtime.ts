import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** PATH 里只放 Node/npm 链接；选中转调脚本，避免 realpath 又把 nvm 的全局适配器带回来。 */
export async function createAdapterTestRuntime(profile: string, npm?: string) {
  const bin = join(profile, 'bin');
  const home = join(profile, 'home');
  const cache = join(profile, 'npm-cache');
  const runtime = join(profile, 'runtime');
  for (const path of [bin, home, cache, runtime]) await mkdir(path, { recursive: true });
  await symlink(process.execPath, join(bin, 'node'));
  await symlink(npm ?? (await realpath(join(dirname(process.execPath), 'npm'))), join(bin, 'npm'));
  const wrapper = join(runtime, 'node');
  const quotedNode = `'${process.execPath.replace(/'/g, "'\\''")}'`;
  await writeFile(wrapper, `#!/bin/sh\nexec ${quotedNode} "$@"\n`, { mode: 0o755 });
  return {
    nodePath: await realpath(wrapper),
    env: {
      NODE_ENV: 'test',
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      npm_config_cache: cache,
      NPM_CONFIG_CACHE: cache,
      // env 是全量替换而非继承：这里不传 TMPDIR 的话，macOS 上应用内 os.tmpdir() 会从
      // /var/folders/... 回退成 /tmp，而 --user-data-dir 建在 runner 的临时根下，启动期
      // 的 E2E profile 隔离安全闸（e2e-profile-guard）会误判为越界并 app.exit(1)。
      TMPDIR: tmpdir(),
      // 与全局 E2E 启动约定一致（见 electron.e2e.ts 的 e2eEnv）：主进程不抢系统焦点。
      PILION_E2E_NO_FOCUS: '1',
    },
  };
}
