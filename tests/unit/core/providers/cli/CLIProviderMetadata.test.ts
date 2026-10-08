import {
  type CLIProviderMetadata,
  formatCLICommand,
  resolveCLIInstallCommand,
  resolveCLIInstallerUrl,
  resolveCLIUpdateCommand,
  resolveLatestVersionNpmPackage,
} from '@/core/providers/cli/CLIProviderMetadata';

const base: CLIProviderMetadata = {
  binaryName: 'example',
  displayName: 'Example',
  npmPackage: '@scope/example',
};

it('falls back to a global npm install of @latest', () => {
  expect(resolveCLIInstallCommand(base)).toEqual({
    command: 'npm',
    args: ['install', '-g', '@scope/example@latest'],
  });
  expect(resolveCLIUpdateCommand(base)).toEqual({
    command: 'npm',
    args: ['install', '-g', '@scope/example@latest'],
  });
});

it('prefers an explicit install command over the npm default', () => {
  const metadata: CLIProviderMetadata = {
    ...base,
    install: { command: 'brew', args: ['install', 'example'] },
    update: { command: 'brew', args: ['upgrade', 'example'] },
  };

  expect(resolveCLIInstallCommand(metadata)).toEqual({ command: 'brew', args: ['install', 'example'] });
  expect(resolveCLIUpdateCommand(metadata)).toEqual({ command: 'brew', args: ['upgrade', 'example'] });
});

it('applies the current platform override before the generic command', () => {
  const metadata: CLIProviderMetadata = {
    ...base,
    platform: { [process.platform]: { install: { command: 'winget', args: ['install', 'example'] }, installerUrl: 'https://example.test/install' } },
  };

  expect(resolveCLIInstallCommand(metadata)).toEqual({ command: 'winget', args: ['install', 'example'] });
  expect(resolveCLIInstallerUrl(metadata)).toBe('https://example.test/install');
});

it('returns null when no install path can be derived at all', () => {
  const metadata: CLIProviderMetadata = { binaryName: 'example', displayName: 'Example' };

  expect(resolveCLIInstallCommand(metadata)).toBeNull();
  expect(resolveCLIUpdateCommand(metadata)).toBeNull();
  expect(resolveCLIInstallerUrl(metadata)).toBeNull();
});

it('switches the latest-version package for an installed major that ships separately', () => {
  const metadata: CLIProviderMetadata = {
    ...base,
    latestVersionNpmPackagesByMajor: { 2: '@scope/example-v2' },
  };

  expect(resolveLatestVersionNpmPackage(metadata, '2.0.25')).toBe('@scope/example-v2');
  expect(resolveLatestVersionNpmPackage(metadata, '1.18.35')).toBe('@scope/example');
  expect(resolveLatestVersionNpmPackage(metadata, null)).toBe('@scope/example');
});

it('formats commands for display, quoting arguments that would break a shell line', () => {
  expect(formatCLICommand({ command: 'npm', args: ['install', '-g', '@scope/example@latest'] }))
    .toBe('npm install -g @scope/example@latest');
  expect(formatCLICommand({ command: 'bash', args: ['-c', 'echo "hi there"'] }))
    .toBe(`bash -c 'echo "hi there"'`);
});
