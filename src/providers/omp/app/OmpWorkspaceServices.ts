import type { ProviderCommandCatalog } from '../../../core/providers/commands/ProviderCommandCatalog';
import type {
  ProviderHost,
} from '../../../core/providers/ProviderHost';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { OmpCommandCatalog } from '../commands/OmpCommandCatalog';
import { OmpCommandMetadataProbe } from '../execution/OmpCommandMetadataProbe';
import { OmpCLIResolver } from '../runtime/OmpCLIResolver';
import { createOmpModels } from '../runtime/OmpModels';
import { createOmpSettingsTabRenderer } from '../ui/OmpSettingsTab';
import { OmpCommandLoader } from './OmpCommandLoader';

export interface OmpWorkspaceServices extends ProviderWorkspaceServices {
  commandCatalog: ProviderCommandCatalog;
  dispose(): Promise<void>;
}

export interface OmpWorkspaceServicesOptions {
  readonly commandMetadataProbe?: OmpCommandMetadataProbe;
}

export async function createOmpWorkspaceServices(
  plugin: ProviderHost,
  options: OmpWorkspaceServicesOptions = {},
): Promise<OmpWorkspaceServices> {
  const commandMetadataProbe = options.commandMetadataProbe
    ?? new OmpCommandMetadataProbe(plugin);
  const modelCatalog = createOmpModels(plugin);
  const unregisterTransitionHook = plugin.executionLifecycleRegistry
    .registerTransitionHook('omp', {
      beforeTransition: async () => {
        modelCatalog.beginTransition();
        commandMetadataProbe.beginEnvironmentTransition();
        await Promise.all([modelCatalog.quiesce(), commandMetadataProbe.quiesceForEnvironmentChange()]);
      },
      afterTransition: async () => {
        try {
          await commandMetadataProbe.quiesceForEnvironmentChange();
        } finally {
          commandMetadataProbe.endEnvironmentTransition();
          modelCatalog.endTransition();
        }
      },
    });

  const cliResolver = new OmpCLIResolver();
  return {
    cliResolver,
    modelCatalog,
    commandCatalog: new OmpCommandCatalog(),
    commandLoader: new OmpCommandLoader(commandMetadataProbe),
    settingsTabRenderer: createOmpSettingsTabRenderer({ cliResolver, modelCatalog }),
    async dispose() {
      unregisterTransitionHook();
      await Promise.all([commandMetadataProbe.dispose(), modelCatalog.dispose()]);
    },
  };
}

export const ompWorkspaceRegistration: ProviderWorkspaceRegistration<OmpWorkspaceServices> = {
  consumesAgentSkills: true,
  initialize: async ({ plugin }) => createOmpWorkspaceServices(plugin),
};

export function getOmpWorkspaceServices(): OmpWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices('omp') as OmpWorkspaceServices;
}
