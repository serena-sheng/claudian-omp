import { ProviderModelCatalogController } from '../../../core/providers/models/ProviderModelCatalog';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getOmpProviderSettings, updateOmpProviderSettings } from '../settings';
import { OmpModelDiscoveryService } from './OmpModelDiscoveryService';

export function createOmpModels(host: ProviderHost): ProviderModelCatalogController {
  const discovery = new OmpModelDiscoveryService(host);
  return new ProviderModelCatalogController({
    providerId: 'omp',
    host,
    update: updateOmpProviderSettings,
    providerName: 'OMP',
    read: (settings = host.settings) => {
      const current = getOmpProviderSettings(settings);
      return {
        enabled: current.enabled,
        models: current.discoveredModels.map(model => ({
          id: model.encodedId, name: model.label, providerKey: model.provider, providerLabel: model.provider,
          description: [
            model.api,
            model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : '',
            model.reasoning ? `thinking: ${model.thinkingLevels.join(', ')}` : 'thinking: off',
          ].filter(Boolean).join(' | '),
        })).reverse(),
        selectedIds: current.visibleModels,
        aliases: current.modelAliases,
      };
    },
    discover: async signal => {
      const result = await discovery.discoverModels(signal);
      if (result.kind === 'skipped') return { changed: false };
      if (result.diagnostics) return { changed: false, diagnostics: result.diagnostics };
      await host.mutateSettingsConditionally(settings => {
        if (signal.aborted) return false;
        updateOmpProviderSettings(settings, { discoveredModels: result.models });
        return true;
      });
      if (signal.aborted) return { changed: false };
      host.notifyProviderChatOptionsChanged('omp');
      return { changed: true };
    },
  });
}
