import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
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
    },
  };
}
