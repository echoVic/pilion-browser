import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Configuration } from 'electron-builder';
import { expect, it } from 'vitest';

const builderRequire = createRequire(import.meta.resolve('electron-builder'));
builderRequire('app-builder-lib');
const { load } = builderRequire('js-yaml') as { load(text: string): Configuration };
const config = load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));

interface NamingPackager {
  expandArtifactNamePattern(options: unknown, extension: string, arch: number): string;
}
const { LinuxPackager } = builderRequire('app-builder-lib/out/linuxPackager') as {
  LinuxPackager: new (info: {
    config: Configuration;
    metadata: { name: string; version: string };
    buildResourcesDir: string;
  }) => NamingPackager;
};
const { default: AppImageTarget } = builderRequire(
  'app-builder-lib/out/targets/appimage/AppImageTarget',
) as {
  default: new (
    name: string,
    packager: NamingPackager,
    helper: object,
    outDir: string,
  ) => { options: unknown };
};
const { Arch } = builderRequire('builder-util') as { Arch: { x64: number } };

it('keeps the AppImage path stable across releases while deb files carry their version', () => {
  const names = (version: string) => {
    const packager = new LinuxPackager({
      config,
      metadata: { name: 'pilion-browser', version },
      buildResourcesDir: '/unused',
    });
    // 只走真实打包器的选项合并与命名，不生成包或下载工具链。
    const appImage = new AppImageTarget('appImage', packager, {}, '/unused');
    return {
      appImage: packager.expandArtifactNamePattern(appImage.options, 'AppImage', Arch.x64),
      deb: packager.expandArtifactNamePattern(config.deb, 'deb', Arch.x64),
    };
  };
  expect(names('0.1.9')).toEqual({
    appImage: 'Pilion-linux-x86_64.AppImage',
    deb: 'Pilion-0.1.9-linux-amd64.deb',
  });
  expect(names('0.2.0')).toEqual({
    appImage: 'Pilion-linux-x86_64.AppImage',
    deb: 'Pilion-0.2.0-linux-amd64.deb',
  });
});
