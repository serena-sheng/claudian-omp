import * as fs from 'fs';
import * as path from 'path';

import { DshCLIResolver } from '@/providers/dsh/runtime/DshCLIResolver';

jest.mock('fs');
const mockedStat = fs.statSync as jest.Mock;

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'current-host',
}));

describe('DshCLIResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  });

  it('prefers the current host path over synced paths and the legacy path', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/current/dsh' || filePath === '/legacy/dsh') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });

    expect(new DshCLIResolver().resolveFromSettings({
      providerConfigs: { dsh: {
        cliPathsByHost: {
          'current-host': '/current/dsh',
          'other-host': '/other/dsh',
        },
        cliPath: '/legacy/dsh',
      } },
    })).toBe('/current/dsh');
  });

  it('falls back through the legacy path and PATH binary named dsh', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/legacy/dsh') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new DshCLIResolver().resolveFromSettings({
      providerConfigs: { dsh: { cliPath: '/legacy/dsh' } },
    })).toBe('/legacy/dsh');

    const pathBinary = path.join('/provider/bin', 'dsh');
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === pathBinary) {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    expect(new DshCLIResolver().resolveFromSettings({
      providerConfigs: { dsh: { environmentVariables: 'PATH=/provider/bin' } },
    })).toBe(pathBinary);
  });

  it('uses merged provider settings, caches the result, and can be reset', () => {
    mockedStat.mockImplementation((filePath: string) => {
      if (filePath === '/configured/dsh') {
        return { isFile: () => true };
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    const settings = {
      providerConfigs: {
        dsh: {
          cliPathsByHost: { 'current-host': '/configured/dsh' },
        },
      },
    };
    const resolver = new DshCLIResolver();

    expect(resolver.resolveFromSettings(settings)).toBe('/configured/dsh');
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/dsh');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/dsh'))
      .toHaveLength(1);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBe('/configured/dsh');
    expect(mockedStat.mock.calls.filter(([filePath]) => filePath === '/configured/dsh'))
      .toHaveLength(2);
  });

  it('caches null settings resolutions until reset', () => {
    mockedStat.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const resolver = new DshCLIResolver();
    const settings = { providerConfigs: { dsh: {} } };

    expect(resolver.resolveFromSettings(settings)).toBeNull();
    const firstCallCount = mockedStat.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat).toHaveBeenCalledTimes(firstCallCount);

    resolver.reset();
    expect(resolver.resolveFromSettings(settings)).toBeNull();
    expect(mockedStat.mock.calls.length).toBeGreaterThan(firstCallCount);
  });
});
