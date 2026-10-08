import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { DshCommandCatalog } from '../commands/DshCommandCatalog';
import { DshCLIResolver } from '../runtime/DshCLIResolver';
import { DshModelCatalogCoordinator } from '../runtime/DshModelCatalogCoordinator';
import { DshModelDiscoveryService } from '../runtime/DshModelDiscoveryService';
import { createDshModels } from '../runtime/DshModels';
import { dshSettingsTabRenderer } from '../ui/DshSettingsTab';
import { DshCommandLoader } from './DshCommandLoader';
import { DshCommandMetadataProbe } from './DshCommandMetadataProbe';

export interface DshWorkspaceServices extends ProviderWorkspaceServices {
  cliResolver: DshCLIResolver;
  commandCatalog: ProviderCommandCatalog;
  modelCatalogCoordinator: DshModelCatalogCoordinator;
  dispose(): Promise<void>;
}

export interface DshWorkspaceServicesOptions {
  readonly commandMetadataProbe?: DshCommandMetadataProbe;
}

export async function createDshWorkspaceServices(
  plugin: ProviderHost,
  options: DshWorkspaceServicesOptions = {},
): Promise<DshWorkspaceServices> {
  const modelCatalogService = new DshModelDiscoveryService(plugin);
  const modelCatalogCoordinator = new DshModelCatalogCoordinator(
    plugin,
    modelCatalogService,
  );
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new DshCommandMetadataProbe(plugin);
  const modelCatalog = createDshModels(plugin, modelCatalogCoordinator);
  const unregisterTransitionHook =
    plugin.executionLifecycleRegistry.registerTransitionHook('dsh', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        modelCatalogCoordinator.beginEnvironmentTransition();
        commandMetadataProbe.beginEnvironmentTransition();
        await Promise.all([
          modelCatalogCoordinator.quiesceForEnvironmentChange(),
          commandMetadataProbe.quiesceForEnvironmentChange(),
        ]);
      },
      afterTransition: async () => {
        try {
          await Promise.all([
            modelCatalogCoordinator.quiesceForEnvironmentChange(),
            commandMetadataProbe.quiesceForEnvironmentChange(),
          ]);
        } finally {
          modelCatalogCoordinator.endEnvironmentTransition();
          commandMetadataProbe.endEnvironmentTransition();
          modelCatalog.endTransition();
        }
      },
    });

  return {
    cliResolver: new DshCLIResolver(),
    commandCatalog: new DshCommandCatalog(),
    modelCatalogCoordinator,
    commandLoader: new DshCommandLoader(commandMetadataProbe),
    settingsTabRenderer: dshSettingsTabRenderer,
    modelCatalog,
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([
        modelCatalog.dispose(),
        modelCatalogCoordinator.dispose(),
        commandMetadataProbe.dispose(),
      ]);
    },
  };
}

export const dshWorkspaceRegistration: ProviderWorkspaceRegistration<DshWorkspaceServices> = {
  consumesAgentSkills: true,
  initialize: async ({ plugin }) => createDshWorkspaceServices(plugin),
};

export function getDshWorkspaceServices(): DshWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('dsh') as DshWorkspaceServices;
}
