import { describe, expect, it } from 'vitest';
import { updateButton, updateNotice, updateStatusText } from '../src/renderer/update-view';
import type { UpdateStatus } from '../src/shared/contracts';

/** 本地时间 09:05。 */
const at = new Date(2026, 9, 11, 9, 5).getTime();

describe('update section', () => {
  it.each<[UpdateStatus, string]>([
    [{ kind: 'unsupported' }, '开发版本不检查更新'],
    [{ kind: 'idle' }, ''],
    [{ kind: 'checking' }, '正在检查…'],
    [{ kind: 'up-to-date', checkedAt: at }, '已是最新版本（09:05）'],
    [{ kind: 'downloading', version: '0.1.9', percent: 35 }, '正在下载 0.1.9（35%）'],
    [{ kind: 'downloaded', version: '0.1.9' }, '0.1.9 已下载，退出时安装'],
    [{ kind: 'available', version: '0.1.9', url: 'https://example.test' }, '0.1.9 已发布'],
    [
      { kind: 'error', message: '无法连接到 GitHub', at },
      '上次检查失败：无法连接到 GitHub（09:05）',
    ],
  ])('describes %j', (status, text) => {
    expect(updateStatusText(status)).toBe(text);
  });

  it('offers the action that fits the state', () => {
    expect(updateButton({ kind: 'unsupported' })).toBeUndefined();
    expect(updateButton({ kind: 'idle' })).toEqual({
      label: '检查更新',
      action: 'check',
      disabled: false,
    });
    expect(updateButton({ kind: 'checking' })).toEqual({
      label: '检查更新',
      action: 'check',
      disabled: true,
    });
    expect(updateButton({ kind: 'downloading', version: '0.1.9', percent: 5 })).toMatchObject({
      disabled: true,
    });
    expect(updateButton({ kind: 'downloaded', version: '0.1.9' })).toEqual({
      label: '立即重启',
      action: 'install',
      disabled: false,
    });
    expect(
      updateButton({ kind: 'available', version: '0.1.9', url: 'https://example.test' }),
    ).toEqual({
      label: '前往下载',
      action: 'install',
      disabled: false,
    });
    expect(updateButton({ kind: 'error', message: 'x', at })).toMatchObject({
      action: 'check',
      disabled: false,
    });
  });
});

describe('update notice', () => {
  it('appears once a version is downloaded, or published for a deb install', () => {
    expect(updateNotice({ kind: 'downloaded', version: '0.1.9' }, '')).toEqual({
      version: '0.1.9',
      text: 'Pilion 0.1.9 已下载，重启后生效',
      button: '立即重启',
    });
    expect(
      updateNotice({ kind: 'available', version: '0.1.9', url: 'https://example.test' }, ''),
    ).toEqual({ version: '0.1.9', text: 'Pilion 0.1.9 已发布', button: '前往下载' });
  });

  it('stays away while nothing is waiting, and for the version put off with 稍后', () => {
    expect(updateNotice(undefined, '')).toBeUndefined();
    expect(
      updateNotice({ kind: 'downloading', version: '0.1.9', percent: 50 }, ''),
    ).toBeUndefined();
    expect(updateNotice({ kind: 'downloaded', version: '0.1.9' }, '0.1.9')).toBeUndefined();
    expect(updateNotice({ kind: 'downloaded', version: '0.1.10' }, '0.1.9')).toMatchObject({
      version: '0.1.10',
    });
  });
});
