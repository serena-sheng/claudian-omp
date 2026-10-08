import { assessProviderReadiness } from '@/core/providers/ProviderReadiness';

const readyInput = {
  enabled: true,
  cliPath: '/usr/local/bin/example',
  cliVersion: '1.2.3',
  discoveredModelCount: 11,
  selectedModelCount: 2,
};

it('reports every check as disabled while the provider is off', () => {
  const snapshot = assessProviderReadiness({ ...readyInput, enabled: false, cliPath: null, cliVersion: null });

  expect(snapshot.status).toBe('disabled');
  expect(snapshot.checks.map(check => check.status)).toEqual([
    'disabled',
    'disabled',
    'disabled',
    'disabled',
  ]);
  expect(snapshot.checks[0].remediation).toBe('enableProvider');
});

it('blocks on an unresolvable CLI and points at the install step', () => {
  const snapshot = assessProviderReadiness({ ...readyInput, cliPath: null, cliVersion: null });

  expect(snapshot.status).toBe('blocked');
  expect(snapshot.checks).toContainEqual({
    id: 'cli',
    status: 'blocked',
    detail: undefined,
    remediation: 'configureCli',
  });
});

it('blocks when the CLI resolves but reports no version', () => {
  const snapshot = assessProviderReadiness({ ...readyInput, cliVersion: null });

  expect(snapshot.checks[1]).toEqual({ id: 'cli', status: 'blocked', detail: undefined, remediation: 'configureCli' });
});

it('carries the CLI version as detail when the probe succeeded', () => {
  const snapshot = assessProviderReadiness(readyInput);

  expect(snapshot.status).toBe('ready');
  expect(snapshot.checks[1]).toEqual({ id: 'cli', status: 'ready', detail: '1.2.3' });
});

it('treats an empty model catalog as attention and no selection as blocked', () => {
  const snapshot = assessProviderReadiness({
    ...readyInput,
    discoveredModelCount: 0,
    selectedModelCount: 0,
  });

  expect(snapshot.checks[2]).toEqual({ id: 'models', status: 'attention', remediation: 'refreshModels' });
  expect(snapshot.checks[3]).toEqual({ id: 'selection', status: 'blocked', remediation: 'selectModel' });
  // A blocked hard requirement outranks the soft attention state.
  expect(snapshot.status).toBe('blocked');
});

it('reports attention when only the soft model-catalog check is unmet', () => {
  const snapshot = assessProviderReadiness({
    ...readyInput,
    discoveredModelCount: 0,
    selectedModelCount: 1,
  });

  expect(snapshot.status).toBe('attention');
});
