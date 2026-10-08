import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import {
  decodeDshModelId,
  encodeDshModelId,
  findDshModel,
  getDshAvailableReasoningEfforts,
  getDshModelLabel,
  isDshModelSelectionId,
  resolveDshDefaultReasoningEffort,
} from './models';
import { DSH_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  getDshProviderSettings,
  getOrderedDshVisibleModelIds,
  updateDshProviderSettings,
} from './settings';


export const dshModelPolicy: ProviderModelPolicy = {
  permissionModes: DSH_PERMISSION_MODE_POLICY,
  getModelOptions(settings): ProviderUIOption[] {
    const dshSettings = getDshProviderSettings(settings);
    const catalogModels = dshSettings.currentCatalog?.models ?? [];
    const catalogById = new Map(catalogModels.map(model => [model.rawId, model] as const));
    const visibleModelIds = [...getOrderedDshVisibleModelIds(dshSettings)];
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const rawId of visibleModelIds) {
      pushModelOption(options, seen, rawId, catalogById, dshSettings.modelAliases);
    }

    return options;
  },

  getDefaultModel(settings): string | null {
    const dshSettings = getDshProviderSettings(settings);
    const firstVisibleModelId = getOrderedDshVisibleModelIds(dshSettings).find(id => dshSettings.currentCatalog?.models.some(model => model.rawId === id));
    return firstVisibleModelId ? encodeDshModelId(firstVisibleModelId) : null;
  },

  ownsModel(model, settings): boolean {
    return isDshModelSelectionId(model);
  },

  supportsReasoningEffort(model, settings): boolean {
    return getDshAvailableReasoningEfforts(
      getExplicitlySelectedDshModel(model, settings),
    ).length > 0;
  },

  getReasoningOptions(model, settings): ProviderUIOption[] {
    return getDshAvailableReasoningEfforts(
      getExplicitlySelectedDshModel(model, settings),
    ).map(option => ({
      ...(option.description ? { description: option.description } : {}),
      label: option.label,
      value: option.value,
    }));
  },

  getDefaultReasoningValue(model, settings): string {
    const dshSettings = getDshProviderSettings(settings);
    const rawId = decodeDshModelId(model);
    if (!rawId) {
      return '';
    }
    const selectedModel = getExplicitlySelectedDshModel(model, settings);
    const efforts = getDshAvailableReasoningEfforts(selectedModel);
    if (efforts.length === 0) {
      return '';
    }
    return resolveDshDefaultReasoningEffort(
      selectedModel ? { ...selectedModel, reasoningEfforts: [...efforts] } : null,
      dshSettings.preferredReasoningByModel[rawId],
    );
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const normalizedModel = normalizeSelection(model);
    if (!isDshModelSelectionId(normalizedModel)) {
      return;
    }
    clearSavedDshEffortProjection(settings);
    settings.model = normalizedModel;
    settings.effortLevel = this.getDefaultReasoningValue(normalizedModel, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    clearSavedDshEffortProjection(settings);
    const rawId = decodeDshModelId(model);
    if (!rawId) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) {
      return;
    }
    const rawId = decodeDshModelId(model);
    if (!rawId) {
      clearSavedDshEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const dshSettings = getDshProviderSettings(settings);
    const supportedValues = new Set(getDshAvailableReasoningEfforts(
      getExplicitlySelectedDshModel(model, settings),
    ).map(option => option.value));
    const preferredReasoningByModel = { ...dshSettings.preferredReasoningByModel };
    if (supportedValues.has(value)) {
      preferredReasoningByModel[rawId] = value;
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateDshProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },
};

function pushModelOption(
  options: ProviderUIOption[],
  seen: Set<string>,
  rawId: string,
  catalogById: ReadonlyMap<string, { description?: string; displayName: string; rawId: string }>,
  aliases: Record<string, string>,
): void {
  const value = encodeDshModelId(rawId);
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const model = catalogById.get(rawId);
  if (!model) return;
  options.push({
    value,
    label: aliases[rawId] ?? getDshModelLabel(model),
    description: model.description ?? 'Selected in an existing session',
  });
}

function normalizeSelection(model: string): string {
  const normalized = model.trim();
  const rawId = decodeDshModelId(normalized);
  return rawId ? encodeDshModelId(rawId) : model;
}

function getExplicitlySelectedDshModel(
  model: string,
  settings: Record<string, unknown>,
) {
  const rawId = decodeDshModelId(model);
  if (!rawId) {
    return null;
  }
  const dshSettings = getDshProviderSettings(settings);
  const catalogModels = dshSettings.currentCatalog?.models ?? [];
  const visibleModels = dshSettings.visibleModels
    ?? catalogModels.map(entry => entry.rawId);
  if (!visibleModels.includes(rawId)) {
    return null;
  }
  return findDshModel(catalogModels, rawId) ?? {
    displayName: rawId,
    rawId,
    reasoningEfforts: [],
    supportsReasoning: false,
  };
}

function clearSavedDshEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) {
    delete settings.savedProviderEffort.dsh;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
