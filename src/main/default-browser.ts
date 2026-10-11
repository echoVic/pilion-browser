import type { DefaultBrowserStatus } from '../shared/contracts.js';

interface ProtocolClientApp {
  isPackaged: boolean;
  isDefaultProtocolClient(protocol: string): boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
}

function supported(
  app: ProtocolClientApp,
  platform: NodeJS.Platform,
  environment?: string,
): boolean {
  return platform === 'darwin' && (app.isPackaged || environment === 'test');
}

export function getDefaultBrowserStatus(
  app: ProtocolClientApp,
  platform: NodeJS.Platform,
  environment: string | undefined,
): DefaultBrowserStatus {
  const available = supported(app, platform, environment);
  return { supported: available, isDefault: available && app.isDefaultProtocolClient('https') };
}

export function setDefaultBrowser(
  app: ProtocolClientApp,
  platform: NodeJS.Platform,
  environment: string | undefined,
): DefaultBrowserStatus {
  if (supported(app, platform, environment)) {
    app.setAsDefaultProtocolClient('http');
    app.setAsDefaultProtocolClient('https');
  }
  return getDefaultBrowserStatus(app, platform, environment);
}
