import type { CLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { probeProviderReadiness } from '@/core/providers/ProviderReadinessProbe';

const installation: CLIInstallation = {
  path: '/Users/example/.local/bin/omp',
  version: '18.8.0',
  source: 'auto',
};

it('skips the CLI probe entirely while the provider is disabled', async () => {
  const inspectCLI = jest.fn(async () => installation);

  const report = await probeProviderReadiness({
    enabled: false,
    inspectCLI,
    readModelCounts: () => ({ discoveredModelCount: 11, selectedModelCount: 3 }),
  });

  expect(inspectCLI).not.toHaveBeenCalled();
  expect(report.snapshot.status).toBe('disabled');
  expect(report.input).toEqual({
    enabled: false,
    cliPath: null,
    cliVersion: null,
    discoveredModelCount: 11,
    selectedModelCount: 3,
  });
});

it('maps a successful CLI probe into the snapshot detail', async () => {
  const report = await probeProviderReadiness({
    enabled: true,
    inspectCLI: async () => installation,
    readModelCounts: () => ({ discoveredModelCount: 11, selectedModelCount: 3 }),
  });

  expect(report.input.cliPath).toBe(installation.path);
  expect(report.input.cliVersion).toBe('18.8.0');
  expect(report.snapshot.status).toBe('ready');
  expect(report.snapshot.checks[1].detail).toBe('18.8.0');
});

it('treats a missing CLI as an unresolved path', async () => {
  const report = await probeProviderReadiness({
    enabled: true,
    inspectCLI: async () => ({ path: null, version: null, source: 'auto' }),
    readModelCounts: () => ({ discoveredModelCount: 0, selectedModelCount: 0 }),
  });

  expect(report.snapshot.checks[1]).toMatchObject({ id: 'cli', status: 'blocked', remediation: 'configureCli' });
});

it('treats a throwing probe as unknown rather than ready', async () => {
  const report = await probeProviderReadiness({
    enabled: true,
    inspectCLI: async () => {
      throw new Error('spawn failed');
    },
  });

  expect(report.input.cliPath).toBeNull();
  expect(report.input.cliVersion).toBeNull();
  expect(report.snapshot.checks[1].status).toBe('blocked');
});

it('defaults the model counts to zero when no catalog source is wired', async () => {
  const report = await probeProviderReadiness({
    enabled: true,
    inspectCLI: async () => installation,
  });

  expect(report.input.discoveredModelCount).toBe(0);
  expect(report.input.selectedModelCount).toBe(0);
  expect(report.snapshot.status).toBe('blocked');
});
