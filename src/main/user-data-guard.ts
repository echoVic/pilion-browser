import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 在测试模式下强制使用临时 userData，避免误写用户真实 profile。
 * 仅当命令行未显式传 --user-data-dir 时才覆盖；显式传入的一律尊重。
 * 必须在任何 app.getPath('userData') 调用之前执行。
 */
export function enforceIsolatedUserData(): void {
  // 显式传了 --user-data-dir，尊重调用方选择（E2E 已自带隔离 profile）。
  if (process.argv.some((arg) => arg.startsWith('--user-data-dir='))) return;
  // 非测试模式不动用户真实 profile。
  if (!process.env.NODE_ENV && !process.env.PILION_E2E && !process.env.PWTEST) return;

  const forced = mkdtempSync(join(tmpdir(), 'pillion-e2e-profile-'));
  app.setPath('userData', forced);
  console.log(`[user-data-guard] test mode: forced userData to ${forced}`);
}
