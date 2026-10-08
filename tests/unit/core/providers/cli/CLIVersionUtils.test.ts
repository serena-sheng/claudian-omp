import { compareVersions, fetchLatestCLIVersion, isUpdateAvailable } from '@/core/providers/cli/CLIVersionUtils';

describe('compareVersions', () => {
  it('orders releases by major, minor, and patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('orders prereleases below their release and compares numeric identifiers numerically', () => {
    expect(compareVersions('1.2.3-next.2', '1.2.3')).toBeLessThan(0);
    expect(compareVersions('1.2.3-next.10', '1.2.3-next.9')).toBeGreaterThan(0);
  });

  it('treats unparseable versions as equal rather than throwing', () => {
    expect(compareVersions('not-a-version', '1.2.3')).toBe(0);
  });
});

describe('isUpdateAvailable', () => {
  it('only reports an update for a strictly newer release', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false);
    expect(isUpdateAvailable('2.0.0', '1.9.0')).toBe(false);
  });

  it('does not flag a prerelease of the same base version as behind', () => {
    expect(isUpdateAvailable('1.2.3-next.1', '1.2.3')).toBe(false);
  });

  it('stays quiet when either side is unknown', () => {
    expect(isUpdateAvailable(null, '1.0.0')).toBe(false);
    expect(isUpdateAvailable('1.0.0', null)).toBe(false);
  });
});

describe('fetchLatestCLIVersion', () => {
  it('reads the version field from the registry payload', async () => {
    const fetcher = jest.fn(async (url: string) => ({ status: 200, json: { version: '3.4.5' } }));

    await expect(fetchLatestCLIVersion('@scope/pkg', { fetcher })).resolves.toBe('3.4.5');
    expect(fetcher).toHaveBeenCalledWith('https://registry.npmjs.org/@scope/pkg/latest');
  });

  it('returns null for non-2xx responses, shapeless payloads, and unreachable registries', async () => {
    await expect(fetchLatestCLIVersion('pkg', { fetcher: async () => ({ status: 404, json: {} }) })).resolves.toBeNull();
    await expect(fetchLatestCLIVersion('pkg', { fetcher: async () => ({ status: 200, json: {} }) })).resolves.toBeNull();
    await expect(fetchLatestCLIVersion('pkg', {
      fetcher: async () => {
        throw new Error('offline');
      },
    })).resolves.toBeNull();
  });

  it('gives up on a hanging registry request instead of blocking the UI', async () => {
    jest.useFakeTimers();
    try {
      // tsconfig lib predates Promise.withResolvers; this promise must never settle.
      const pending = fetchLatestCLIVersion('pkg', {
        fetcher: () => new Promise(() => undefined),
        timeoutMs: 50,
      });
      jest.advanceTimersByTime(50);
      await expect(pending).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
