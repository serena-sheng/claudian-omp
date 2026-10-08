const mockDiscoverCatalog = jest.fn();

jest.mock('@/providers/dsh/runtime/DshModelDiscoveryService', () => ({
  DshModelDiscoveryService: jest.fn().mockImplementation(() => ({
    discoverCatalog: mockDiscoverCatalog,
  })),
}));

import { DshCommandLoader } from '@/providers/dsh/app/DshCommandLoader';
import { DshCommandMetadataProbe } from '@/providers/dsh/app/DshCommandMetadataProbe';
import {
  createDshWorkspaceServices,
  dshWorkspaceRegistration,
} from '@/providers/dsh/app/DshWorkspaceServices';
import { DshCommandCatalog } from '@/providers/dsh/commands/DshCommandCatalog';
import { DshCLIResolver } from '@/providers/dsh/runtime/DshCLIResolver';
import { dshSettingsTabRenderer } from '@/providers/dsh/ui/DshSettingsTab';

function createPlugin(cached = true): any {
  const catalog = {
    defaultModelId: 'dsh-4.5',
    fingerprint: 'cached-fingerprint',
    models: [{ displayName: 'Dsh 4.5', rawId: 'dsh-4.5' }],
    refreshedAt: Date.now(),
  };
  const settings = {
    providerConfigs: {
      dsh: {
        catalogsByHost: cached ? { 'device:current': catalog } : {},
        enabled: true,
      },
    },
  };
  return {
    app: { vault: { adapter: { basePath: '/tmp/dsh-workspace' } } },
    executionLifecycleRegistry: {
      registerTransitionHook: jest.fn(() => jest.fn()),
    },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/opt/dsh/bin/dsh'),
    mutateSettingsConditionally: jest.fn(async (mutation: (value: any) => boolean) => {
      await mutation(settings);
    }),
    notifyProviderChatOptionsChanged: jest.fn(),
    settings,
  };
}

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'device:current',
}));

describe('DshWorkspaceServices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDiscoverCatalog.mockResolvedValue({
      defaultModelId: 'dsh-4.5',
      fingerprint: 'fresh-fingerprint',
      kind: 'completed',
      models: [{ displayName: 'Dsh 4.5', rawId: 'dsh-4.5' }],
    });
  });

  it('initializes only workspace-owned services and never creates a warmup session', async () => {
    const plugin = createPlugin();
    const services = await dshWorkspaceRegistration.initialize({ plugin } as any);

    expect(services.cliResolver).toBeInstanceOf(DshCLIResolver);
    expect(services.commandCatalog).toBeInstanceOf(DshCommandCatalog);
    expect(services.settingsTabRenderer).toBe(dshSettingsTabRenderer);
    expect(services.commandLoader).toBeInstanceOf(DshCommandLoader);
    expect(services).not.toHaveProperty('beginAuxiliaryServicesEnvironmentChange');
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
  });

  it('exposes cached catalog state and performs explicit refresh through the coordinator', async () => {
    const services = await createDshWorkspaceServices(createPlugin());

    expect(services.modelCatalogCoordinator.getCachedCatalog()).toEqual(
      expect.objectContaining({ fingerprint: 'cached-fingerprint' }),
    );
    await expect(services.modelCatalog!.refresh({ force: true })).resolves.toEqual({
      changed: false,
      diagnostics: undefined,
    });
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);
  });

  it('disposes its explicitly requested catalog discovery', async () => {
    let releaseRefresh!: (value: unknown) => void;
    mockDiscoverCatalog.mockReturnValue(new Promise(resolve => { releaseRefresh = resolve; }));
    const services = await createDshWorkspaceServices(createPlugin());
    const dispose = jest.spyOn(services.modelCatalogCoordinator, 'dispose');

    const refresh = services.modelCatalog!.refresh();
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);

    const disposing = services.dispose();
    releaseRefresh({ kind: 'skipped', reason: 'provider-disabled' });
    await disposing;
    await refresh;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('registers a transition hook that drains model probes and unregisters on dispose', async () => {
    const plugin = createPlugin();
    const unregister = jest.fn();
    const commandMetadataProbe = {
      beginEnvironmentTransition: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
      endEnvironmentTransition: jest.fn(),
      load: jest.fn(),
      quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    };
    let hook: {
      afterTransition(): Promise<void>;
      beforeTransition(): Promise<void>;
    } | undefined;
    plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
      (_providerId: string, registeredHook: typeof hook) => {
        hook = registeredHook;
        return unregister;
      },
    );
    const services = await createDshWorkspaceServices(plugin, {
      commandMetadataProbe: commandMetadataProbe as any,
    });
    const quiesce = jest.spyOn(
      services.modelCatalogCoordinator,
      'quiesceForEnvironmentChange',
    ).mockResolvedValue();

    await hook?.beforeTransition();
    await services.dispose();

    expect(plugin.executionLifecycleRegistry.registerTransitionHook).toHaveBeenCalledWith(
      'dsh',
      {
        afterTransition: expect.any(Function),
        beforeTransition: expect.any(Function),
      },
    );
    expect(quiesce).toHaveBeenCalledTimes(1);
    expect(commandMetadataProbe.quiesceForEnvironmentChange).toHaveBeenCalledTimes(1);
    expect(commandMetadataProbe.dispose).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('fences command and model metadata behind one workspace transition hook', async () => {
    const plugin = createPlugin();
    let cliPath = '/configured/dsh-a';
    plugin.getResolvedProviderCliPath.mockImplementation(async () => cliPath);
    const nativeCreate = jest.fn((options: any) => ({
      cancel: jest.fn(),
      initialize: jest.fn(async () => undefined),
      listCommands: jest.fn(async () => [{
        content: '',
        id: `dsh:${options.command}`,
        kind: 'command' as const,
        name: `from-${options.command}`,
        source: 'sdk' as const,
      }]),
      loadSession: jest.fn(),
      newSession: jest.fn(),
      onNotification: jest.fn(() => jest.fn()),
      prompt: jest.fn(),
      setMode: jest.fn(),
      setModel: jest.fn(),
      shutdown: jest.fn(async () => undefined),
    }));
    const commandMetadataProbe = new DshCommandMetadataProbe(
      plugin,
      { create: nativeCreate },
    );
    let hook!: {
      afterTransition(): Promise<void>;
      beforeTransition(): Promise<void>;
    };
    plugin.executionLifecycleRegistry.registerTransitionHook.mockImplementation(
      (_providerId: string, registeredHook: typeof hook) => {
        hook = registeredHook;
        return jest.fn();
      },
    );
    const services = await createDshWorkspaceServices(plugin, {
      commandMetadataProbe,
    });

    await hook.beforeTransition();
    plugin.mutateSettingsConditionally.mockClear();
    const commandLoad = services.commandLoader!.loadCommands({
      allowIsolatedMetadataCreation: true,
      conversation: null,
      plugin,
    });
    const ensure = services.modelCatalogCoordinator.refresh();
    const refresh = services.modelCatalogCoordinator.refresh();
    const liveMerge = services.modelCatalogCoordinator.mergeLiveModels([{
      displayName: 'Live B',
      rawId: 'live-b',
      reasoningEfforts: [],
      supportsReasoning: false,
    }]);
    await Promise.resolve();

    expect(nativeCreate).not.toHaveBeenCalled();
    expect(mockDiscoverCatalog).not.toHaveBeenCalled();
    expect(plugin.mutateSettingsConditionally).not.toHaveBeenCalled();

    cliPath = '/configured/dsh-b';
    plugin.settings.providerConfigs.dsh.environmentVariables = 'DSH_PROFILE=b';
    await hook.afterTransition();
    await expect(commandLoad).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'from-/configured/dsh-b' })],
      status: 'ready',
    });
    await Promise.all([ensure, refresh, liveMerge]);
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(nativeCreate.mock.calls[0][0]).toMatchObject({
      command: '/configured/dsh-b',
    });
    expect(mockDiscoverCatalog).toHaveBeenCalledTimes(1);

    await services.dispose();
  });
});
