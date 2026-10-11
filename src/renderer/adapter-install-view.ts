import type { AdapterInstallState } from '../shared/contracts';

export function adapterInstallText(install: AdapterInstallState, now: number): string {
  const seconds = Math.max(0, Math.floor((now - install.startedAt) / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const downloaded =
    install.downloadedBytes === undefined
      ? ''
      : ` · 已下载 ${(install.downloadedBytes / 1_000_000).toFixed(1)} MB`;
  return `正在下载 ACP 适配器${downloaded} · ${elapsed}`;
}

/** 读屏只播开始和结束，不跟着下载量和时间刷新。 */
export function adapterInstallAnnouncement(install: AdapterInstallState | undefined): string {
  return install ? `正在安装 ${install.name} 的 ACP 适配器` : 'ACP 适配器安装已结束';
}
