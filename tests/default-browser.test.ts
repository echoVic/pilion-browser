import { expect, it, vi } from 'vitest';
import { getDefaultBrowserStatus, setDefaultBrowser } from '../src/main/default-browser';

function protocolApp(isPackaged: boolean, isDefault = false) {
  return {
    isPackaged,
    isDefaultProtocolClient: vi.fn<(scheme: string) => boolean>(() => isDefault),
    setAsDefaultProtocolClient: vi.fn<(scheme: string) => boolean>(() => true),
  };
}

it.each([
  ['darwin', true, undefined, true],
  ['darwin', false, 'test', true],
  ['darwin', false, 'development', false],
  ['darwin', false, undefined, false],
  ['linux', true, 'test', false],
  ['win32', true, 'test', false],
] as const)(
  'supports %s packaged=%s NODE_ENV=%s only when safe',
  (platform, packaged, env, supported) => {
    const app = protocolApp(packaged, true);
    expect(getDefaultBrowserStatus(app, platform, env)).toEqual({
      supported,
      isDefault: supported,
    });
    if (supported) expect(app.isDefaultProtocolClient).toHaveBeenCalledWith('https');
    else expect(app.isDefaultProtocolClient).not.toHaveBeenCalled();
  },
);

it('requests both web schemes and reads https status after the system request', () => {
  const app = protocolApp(true);
  app.setAsDefaultProtocolClient.mockImplementation((scheme?: string) => {
    if (scheme === 'https') app.isDefaultProtocolClient.mockReturnValue(true);
    return true;
  });
  expect(setDefaultBrowser(app, 'darwin', undefined)).toEqual({ supported: true, isDefault: true });
  expect(app.setAsDefaultProtocolClient.mock.calls).toEqual([['http'], ['https']]);
});

it('keeps the status false when the person has not accepted the system dialog', () => {
  const app = protocolApp(true);
  expect(setDefaultBrowser(app, 'darwin', undefined)).toEqual({
    supported: true,
    isDefault: false,
  });
  expect(app.setAsDefaultProtocolClient.mock.calls).toEqual([['http'], ['https']]);
});

it.each(['darwin', 'linux', 'win32'] as const)(
  'never registers an unsupported %s build',
  (platform) => {
    const app = protocolApp(false);
    expect(setDefaultBrowser(app, platform, 'development')).toEqual({
      supported: false,
      isDefault: false,
    });
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(app.isDefaultProtocolClient).not.toHaveBeenCalled();
  },
);
