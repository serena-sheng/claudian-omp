import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { NormalizedDshSessionModels } from '@/providers/dsh/execution/DshSessionModelMetadata';
import type { DshDiscoveredModel } from '@/providers/dsh/models';
import {
  buildDshCatalogFingerprint,
  type DshCatalogCommandRequest,
  type DshCatalogCommandResult,
  type DshCatalogCommandRunner,
  DshModelDiscoveryService,
  SpawnDshCatalogCommandRunner,
} from '@/providers/dsh/runtime/DshModelDiscoveryService';
import type { DshModelCatalogProbeLike, DshModelCatalogProbeRequest } from '@/providers/dsh/runtime/DshModelCatalogProbe';

const dsh4: DshDiscoveredModel = {
  displayName: 'Dsh 4',
  rawId: 'dsh-4',
  reasoningEfforts: [],
  supportsReasoning: false,
};

function makeProbe(
  implementation: DshModelCatalogProbeLike['discover'],
): DshModelCatalogProbeLike & { requests: DshModelCatalogProbeRequest[] } {
  const requests: DshModelCatalogProbeRequest[] = [];
  return {
    requests,
    discover: jest.fn(async (request) => {
      requests.push(request);
      return implementation(request);
    }),
  };
}

function makeHost(enabled = true): ProviderHost {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(async () => '/opt/dsh/bin/dsh'),
    settings: {
      providerConfigs: {
        dsh: {
          enabled,
          environmentVariables: 'XAI_API_KEY=super-secret\nCUSTOM_MODEL_SOURCE=enabled',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example',
    },
  } as unknown as ProviderHost;
}

function makeRunner(
  versionResult: DshCatalogCommandResult = {
    exitCode: 0,
    stdout: 'dsh 0.2.106\n',
  },
): DshCatalogCommandRunner & { requests: DshCatalogCommandRequest[] } {
  const requests: DshCatalogCommandRequest[] = [];
  return {
    requests,
    run: jest.fn(async (request) => {
      requests.push(request);
      return versionResult;
    }),
  };
}

describe('DshModelDiscoveryService', () => {
  it('discovers models through the ACP catalog probe with the provider runtime environment', async () => {
    const runner = makeRunner();
    const probe = makeProbe(async (): Promise<NormalizedDshSessionModels> => ({
      currentModelId: 'dsh-4',
      models: [dsh4],
    }));
    const service = new DshModelDiscoveryService(makeHost(), { probe, runner });

    const result = await service.discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: 'dsh-4',
      kind: 'completed',
      models: [expect.objectContaining({ rawId: 'dsh-4' })],
    });
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Dsh model discovery');
    }
    expect(result.fingerprint).toMatch(/^1:[a-f0-9]{64}$/);
    expect(result.fingerprint).not.toContain('super-secret');
    // The runner only fingerprints the CLI version; models come from the probe.
    expect(runner.requests.map(request => request.args)).toEqual([
      ['--version'],
    ]);
    expect(probe.requests).toEqual([
      expect.objectContaining({
        command: '/opt/dsh/bin/dsh',
        cwd: '/vault',
      }),
    ]);
    expect(probe.requests[0].env).toMatchObject({
      CUSTOM_MODEL_SOURCE: 'enabled',
      HTTPS_PROXY: 'https://proxy.example',
      XAI_API_KEY: 'super-secret',
    });
  });

  it('skips without resolving or launching when Dsh is disabled', async () => {
    const host = makeHost(false);
    const runner = makeRunner();
    const probe = makeProbe(async () => ({ currentModelId: null, models: [] }));

    await expect(new DshModelDiscoveryService(host, { probe, runner }).discoverCatalog()).resolves.toEqual({
      kind: 'skipped',
      reason: 'provider-disabled',
    });
    expect(host.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(probe.discover).not.toHaveBeenCalled();
  });

  it('returns concise diagnostics when the ACP probe fails without exposing details', async () => {
    const runner = makeRunner();
    const probe = makeProbe(async () => {
      throw new Error('session/new rejected with token=super-secret');
    });

    const result = await new DshModelDiscoveryService(makeHost(), { probe, runner }).discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: null,
      diagnostics: 'DeepSeek Harness ACP model discovery failed',
      kind: 'completed',
      models: [],
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('reports cancellation when discovery is aborted', async () => {
    const runner = makeRunner();
    const probe = makeProbe(async () => {
      throw new Error('aborted');
    });
    const signal = AbortSignal.abort();

    const result = await new DshModelDiscoveryService(makeHost(), { probe, runner }).discoverCatalog(signal);

    expect(result).toMatchObject({
      defaultModelId: null,
      diagnostics: 'DeepSeek Harness model discovery was cancelled',
      kind: 'completed',
      models: [],
    });
  });

  it('returns startup diagnostics when the CLI cannot be resolved', async () => {
    const host = makeHost();
    host.getResolvedProviderCliPath = jest.fn(async () => {
      throw new Error('no CLI');
    });
    const runner = makeRunner();
    const probe = makeProbe(async () => ({ currentModelId: null, models: [] }));

    const result = await new DshModelDiscoveryService(host, { probe, runner }).discoverCatalog();

    expect(result).toMatchObject({
      defaultModelId: null,
      diagnostics: 'DeepSeek Harness model discovery could not be started',
      kind: 'completed',
      models: [],
    });
    expect(probe.discover).not.toHaveBeenCalled();
  });

  it('fingerprints CLI identity/version and environment key names, never values', () => {
    const first = buildDshCatalogFingerprint({
      command: '/opt/dsh/bin/dsh',
      environmentKeys: ['XAI_API_KEY', 'CUSTOM_MODEL_SOURCE'],
      version: 'dsh 0.2.106',
    });
    const sameNamesDifferentOrder = buildDshCatalogFingerprint({
      command: '/opt/dsh/bin/dsh',
      environmentKeys: ['CUSTOM_MODEL_SOURCE', 'XAI_API_KEY'],
      version: 'dsh 0.2.106',
    });
    const upgraded = buildDshCatalogFingerprint({
      command: '/opt/dsh/bin/dsh',
      environmentKeys: ['CUSTOM_MODEL_SOURCE', 'XAI_API_KEY'],
      version: 'dsh 0.2.107',
    });

    expect(first).toBe(sameNamesDifferentOrder);
    expect(first).not.toBe(upgraded);
    expect(first).toMatch(/^1:[a-f0-9]{64}$/);
  });
});

describe('SpawnDshCatalogCommandRunner', () => {
    // Integration test: exercises the real wall-clock process-termination
    // timeout, which fake timers cannot drive.
    it('terminates a command at the configured timeout', async () => {
      const result = await new SpawnDshCatalogCommandRunner().run({
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      command: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 20,
    });

    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      termination: 'timeout',
    });
  });
});
