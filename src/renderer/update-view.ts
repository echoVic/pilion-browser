import type { UpdateStatus } from '../shared/contracts';

/** 读屏只播状态种类；进度、时间和错误详情留在可见文字里。 */
export function updateStatusAnnouncement(kind: UpdateStatus['kind']): string {
  switch (kind) {
    case 'unsupported':
      return '开发版本不检查更新';
    case 'idle':
      return '';
    case 'checking':
      return '正在检查更新';
    case 'up-to-date':
      return '已是最新版本';
    case 'downloading':
      return '正在下载更新';
    case 'downloaded':
      return '更新已下载，退出时安装';
    case 'available':
      return '新版本已发布';
    case 'error':
      return '更新失败，请查看详情';
  }
}

/** 设置页「更新」分区的状态文字。 */
export function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return '开发版本不检查更新';
    case 'idle':
      return '';
    case 'checking':
      return '正在检查…';
    case 'up-to-date':
      return `已是最新版本（${clock(status.checkedAt)}）`;
    case 'downloading':
      return `正在下载 ${status.version}（${status.percent}%）`;
    case 'downloaded':
      return `${status.version} 已下载，退出时安装`;
    case 'available':
      return `${status.version} 已发布`;
    case 'error':
      return `上次检查失败：${status.message}（${clock(status.at)}）`;
  }
}

export interface UpdateButton {
  label: string;
  /** check：检查更新；install：已下载时立即重启，deb 有新版本时打开 Release 页面。 */
  action: 'check' | 'install';
  disabled: boolean;
}

/** 状态旁边的按钮；开发版本不显示。 */
export function updateButton(status: UpdateStatus): UpdateButton | undefined {
  switch (status.kind) {
    case 'unsupported':
      return undefined;
    case 'checking':
    case 'downloading':
      return { label: '检查更新', action: 'check', disabled: true };
    case 'downloaded':
      return { label: '立即重启', action: 'install', disabled: false };
    case 'available':
      return { label: '前往下载', action: 'install', disabled: false };
    default:
      return { label: '检查更新', action: 'check', disabled: false };
  }
}

export interface UpdateNotice {
  version: string;
  text: string;
  button: string;
}

/** 主窗口工具栏按钮：已下载或 deb 有新版本时显示，不挤占网页高度。 */
export function updateNotice(status: UpdateStatus | undefined): UpdateNotice | undefined {
  if (status?.kind !== 'downloaded' && status?.kind !== 'available') return undefined;
  return status.kind === 'downloaded'
    ? {
        version: status.version,
        text: `Pilion ${status.version} 已下载，重启后生效`,
        button: '重启以更新',
      }
    : { version: status.version, text: `Pilion ${status.version} 已发布`, button: '前往下载' };
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
