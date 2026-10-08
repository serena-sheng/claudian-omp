import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { getOmpProviderSettings } from '../settings';

export function assertOmpModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getOmpProviderSettings(settings);
  if (!(config.enabled && config.visibleModels.includes(model)
    && config.discoveredModels.some(candidate => candidate.encodedId === model))) {
    throw new ProviderModelUnavailableError('OMP');
  }
}
