import { describe, expect, it } from 'vitest';
import { e2eProfileIsUnsafe } from '../src/main/e2e-profile-guard';

describe('e2eProfileIsUnsafe（E2E userData 隔离判定）', () => {
  const tmp = '/var/folders/ab/T/pilion-e2e-xyz';

  it('非测试模式：即使 userData 落在真实 profile 也放行', () => {
    expect(
      e2eProfileIsUnsafe({
        e2eMode: false,
        userData: '/Users/u/Library/Application Support/pilion-browser',
        tmpRoot: tmp,
      }),
    ).toBe(false);
  });

  it('测试模式：userData 在临时目录下 → 放行（已隔离）', () => {
    expect(
      e2eProfileIsUnsafe({
        e2eMode: true,
        userData: `${tmp}/profile-123`,
        tmpRoot: tmp,
      }),
    ).toBe(false);
  });

  it('测试模式：userData 落在真实 profile（默认路径）→ 拒绝启动', () => {
    expect(
      e2eProfileIsUnsafe({
        e2eMode: true,
        userData: '/Users/u/Library/Application Support/pilion-browser',
        tmpRoot: tmp,
      }),
    ).toBe(true);
  });

  it('测试模式：临时目录带尾斜杠不影响判定', () => {
    expect(
      e2eProfileIsUnsafe({
        e2eMode: true,
        userData: `${tmp}/profile/`,
        tmpRoot: `${tmp}/`,
      }),
    ).toBe(false);
  });

  it('测试模式：临时目录的兄弟目录不算隔离', () => {
    expect(
      e2eProfileIsUnsafe({
        e2eMode: true,
        userData: '/var/folders/ab/T/pilion-e2e-xyz-evil',
        tmpRoot: tmp,
      }),
    ).toBe(true);
  });
});
