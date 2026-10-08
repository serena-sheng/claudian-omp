import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getDshModelLabel } from '../models';
import { getDshProviderSettings, getOrderedDshVisibleModelIds, updateDshProviderSettings } from '../settings';
import type { DshModelCatalogCoordinator } from './DshModelCatalogCoordinator';

export function createDshModels(host: ProviderHost, native: Pick<DshModelCatalogCoordinator, 'refresh'>): ProviderModelCatalogController {
  return new ProviderModelCatalogController({
    providerId: 'dsh',
    host,
    update: updateDshProviderSettings,
    providerName: 'DeepSeek Harness',
    read: (settings = host.settings) => {
      const current = getDshProviderSettings(settings);
      return {
        enabled: current.enabled,
        models: (current.currentCatalog?.models ?? []).map(model => ({
          id: model.rawId, name: getDshModelLabel(model), description: model.description,
        })),
        selectedIds: getOrderedDshVisibleModelIds(current),
        aliases: current.modelAliases,
      };
    },
    discover: async signal => {
      const result = await native.refresh(undefined, signal);
      return { changed: result.changed, diagnostics: result.diagnostics };
    },
  });
}
