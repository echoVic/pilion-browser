import { access, constants } from 'node:fs/promises';
import { handshake, resolveEndpoint } from '../client.js';
import type { StatusReport } from './commands.js';

/**
 * `pilion status` 的检查项：socket 可写 → 凭证可读 → 握手认证 → 服务端版本。
 * 握手应答里的 version 由新版 Pilion 上报；旧版只回 `{}`，此时版本项照样通过，标「旧版未上报」。
 */
export async function checkStatus(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StatusReport> {
  const report: StatusReport = [{ item: 'cli', ok: true, detail: `pilion ${version}` }];
  const socket = env.PILION_EXTERNAL_SOCKET;
  const socketOk =
    Boolean(socket) &&
    (await access(socket!, constants.W_OK).then(
      () => true,
      () => false,
    ));
  report.push({
    item: 'socket',
    ok: socketOk,
    detail: socketOk ? socket! : 'Pilion 没有在运行，或「对外控制」已关闭：请打开 Pilion',
  });
  let endpoint;
  try {
    endpoint = await resolveEndpoint(env);
    report.push({ item: 'credential', ok: true, detail: '已找到' });
  } catch {
    report.push({
      item: 'credential',
      ok: false,
      detail: '没有凭证：在 Pilion「设置 › 对外控制」点「安装到 Agent」',
    });
  }
  if (socketOk && endpoint) {
    try {
      const ack = await handshake(endpoint);
      report.push({ item: 'handshake', ok: true, detail: '已认证' });
      const same = !ack.version || ack.version === version;
      report.push({
        item: 'version',
        ok: same,
        detail: same
          ? `Pilion ${ack.version ?? '(旧版未上报)'}`
          : `Pilion ${ack.version} 与 CLI ${version} 不一致：请重启 Pilion`,
      });
    } catch (error) {
      report.push({
        item: 'handshake',
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)}：凭证可能已被吊销，请重新「安装到 Agent」`,
      });
    }
  }
  return report;
}
