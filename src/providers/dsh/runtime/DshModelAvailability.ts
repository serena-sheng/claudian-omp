import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { decodeDshModelId } from '../models';
import { getDshProviderSettings, getOrderedDshVisibleModelIds } from '../settings';

export function assertDshModelAvailable(settings: Record<string, unknown>, requestedModel: string | undefined): void {
  const model = requestedModel ?? (typeof settings.model === 'string' ? settings.model : '');
  const config = getDshProviderSettings(settings);
  const id = decodeDshModelId(model) ?? '';
  if (!(config.enabled && getOrderedDshVisibleModelIds(config).includes(id)
    && Boolean(config.currentCatalog?.models.some(candidate => candidate.rawId === id)))) {
    throw new ProviderModelUnavailableError('DeepSeek Harness');
  }
}
