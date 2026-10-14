import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => {
  const setPath = vi.fn();
  const getPath = vi.fn((name: string) =>
    name === 'userData' ? '/Users/test/Library/Application Support/pillion-browser' : '/tmp',
  );
  return { app: { setPath, getPath } };
});

import { enforceIsolatedUserData } from '../src/main/user-data-guard';
import { app } from 'electron';

describe('user-data-guard', () => {
  const origArgv = [...process.argv];
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
    delete process.env.PILION_E2E;
    delete process.env.PWTEST;
    process.argv = [process.execPath, 'main.js'];
  });

  afterEach(() => {
    process.argv = origArgv;
    process.env = origEnv;
  });

  it('does not touch userData outside test mode', () => {
    enforceIsolatedUserData();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('forces temp userData when NODE_ENV=test and no --user-data-dir', () => {
    process.env.NODE_ENV = 'test';
    enforceIsolatedUserData();
    expect(app.setPath).toHaveBeenCalledWith('userData', expect.stringContaining('pillion-e2e-profile-'));
  });

  it('respects explicit --user-data-dir flag', () => {
    process.env.NODE_ENV = 'test';
    process.argv = [process.execPath, 'main.js', '--user-data-dir=/custom/profile'];
    enforceIsolatedUserData();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('forces temp userData when PILION_E2E=1', () => {
    process.env.PILION_E2E = '1';
    enforceIsolatedUserData();
    expect(app.setPath).toHaveBeenCalledWith('userData', expect.stringContaining('pillion-e2e-profile-'));
  });

  it('creates the temp directory on disk', () => {
    process.env.NODE_ENV = 'test';
    enforceIsolatedUserData();
    const call = (app.setPath as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    expect(existsSync(call[1])).toBe(true);
  });
});
