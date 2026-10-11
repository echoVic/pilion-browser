import { describe, expect, it } from 'vitest';
import {
  adapterInstallAnnouncement,
  adapterInstallText,
} from '../src/renderer/adapter-install-view';
import type { AdapterInstallState } from '../src/shared/contracts';

const install: AdapterInstallState = {
  presetId: 'claude',
  name: 'Claude Code',
  package: '@agentclientprotocol/claude-agent-acp@0.89.1',
  startedAt: 10_000,
};

describe('adapter install text', () => {
  it.each<[number | undefined, number, string]>([
    [undefined, 10_000, '正在下载 ACP 适配器 · 0:00'],
    [0, 10_900, '正在下载 ACP 适配器 · 已下载 0.0 MB · 0:00'],
    [23_400_000, 75_000, '正在下载 ACP 适配器 · 已下载 23.4 MB · 1:05'],
    [1_250_000, 69_999, '正在下载 ACP 适配器 · 已下载 1.3 MB · 0:59'],
    [100_000_000, 3_610_000, '正在下载 ACP 适配器 · 已下载 100.0 MB · 60:00'],
    [undefined, 9_000, '正在下载 ACP 适配器 · 0:00'],
  ])('formats bytes %s at %s without a percentage', (downloadedBytes, now, text) => {
    expect(adapterInstallText({ ...install, downloadedBytes }, now)).toBe(text);
  });

  it('announces only the start and end, without byte counts or elapsed time', () => {
    expect(adapterInstallAnnouncement(install)).toBe('正在安装 Claude Code 的 ACP 适配器');
    expect(adapterInstallAnnouncement({ ...install, downloadedBytes: 23_400_000 })).toBe(
      adapterInstallAnnouncement(install),
    );
    expect(adapterInstallAnnouncement(undefined)).toBe('ACP 适配器安装已结束');
  });
});
