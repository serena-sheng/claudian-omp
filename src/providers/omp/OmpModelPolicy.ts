import { formatReasoningValueLabel } from '../../core/providers/reasoning';
import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  getOmpSupportedThinkingLevels,
  isOmpModelSelectionId,
  OMP_DEFAULT_THINKING_LEVEL,
  type OmpDiscoveredModel,
  type OmpThinkingLevel,
} from './models';
import {
  getOmpProviderSettings,
  updateOmpProviderSettings,
} from './settings';

const DEFAULT_OMP_REASONING_LEVELS = getOmpSupportedThinkingLevels({ reasoning: true });

export const ompModelPolicy: ProviderModelPolicy = {
  permissionModes: {
    values: ['always-ask', 'write', 'yolo'],
    fallbackValue: 'always-ask',
    defaultValue: 'always-ask',
  },
  getModelOptions(settings): ProviderUIOption[] {
    const ompSettings = getOmpProviderSettings(settings);
    const discoveredModels = new Map(ompSettings.discoveredModels.map((model) => [
      model.encodedId,
      buildModelOption(model, ompSettings.modelAliases[model.encodedId]),
    ]));
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();
    for (const encodedId of [...ompSettings.visibleModels]) {
      const option = discoveredModels.get(encodedId);
      if (option) pushOption(options, seen, encodedId, option);
    }

    return options;
  },

  getDefaultModel(settings: Record<string, unknown>): string | null {
    const current = getOmpProviderSettings(settings);
    return current.visibleModels.find(id => current.discoveredModels.some(model => model.encodedId === id)) ?? null;
  },

  ownsModel(model: string): boolean {
    return isOmpModelSelectionId(model);
  },

  supportsReasoningEffort(model: string, settings: Record<string, unknown>): boolean {
    const ompModel = getCachedModel(model, settings);
    if (ompModel) {
      return ompModel.thinkingLevels.some(level => level !== 'off');
    }

    return !!decodeOmpModelId(model);
  },

  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderUIOption[] {
    const ompModel = getCachedModel(model, settings);
    if (ompModel && !ompModel.reasoning) return [];
    const levels = ompModel?.thinkingLevels
      ?? (decodeOmpModelId(model) ? DEFAULT_OMP_REASONING_LEVELS : ['off']);
    return levels.map((level) => ({
      label: formatReasoningValueLabel(level),
      value: level,
    }));
  },

  getDefaultReasoningValue: getOmpDefaultReasoningValue,

  isDefaultModel(model: string): boolean {
    return isOmpModelSelectionId(model);
  },

  applyModelDefaults: applyOmpModelDefaults,

  applyModelProjectionDefaults: applyOmpModelProjectionDefaults,

  applyReasoningSelection(model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const ompModel = getCachedModel(model, settingsBag);
    const encodedId = ompModel?.encodedId ?? (decodeOmpModelId(model) ? model : '');
    if (!encodedId) {
      return;
    }
    const supportedLevels = ompModel?.thinkingLevels ?? DEFAULT_OMP_REASONING_LEVELS;

    const nextPreferredThinkingByModel = {
      ...getOmpProviderSettings(settingsBag).preferredThinkingByModel,
    };
    const normalizedValue = value as OmpThinkingLevel;
    if (!supportedLevels.includes(normalizedValue)) {
      delete nextPreferredThinkingByModel[encodedId];
    } else {
      nextPreferredThinkingByModel[encodedId] = normalizedValue;
    }

    updateOmpProviderSettings(settingsBag, {
      preferredThinkingByModel: nextPreferredThinkingByModel,
    });
  },

  normalizeAvailableModelSelection(model: string): string {
    return isOmpModelSelectionId(model) ? model : `omp:${model}`;
  },

  normalizeModelVariant(model: string): string {
    return decodeOmpModelId(model) ? model : model;
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },
};

function getCachedModel(model: string, settings: Record<string, unknown>): OmpDiscoveredModel | null {
  if (!decodeOmpModelId(model)) {
    return null;
  }

  return getOmpProviderSettings(settings).discoveredModels.find(entry => entry.encodedId === model) ?? null;
}

function applyOmpModelDefaults(model: string, settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return;
  }

  const settingsBag = settings as Record<string, unknown>;
  if (!decodeOmpModelId(model)) {
    settingsBag.effortLevel = 'off';
    return;
  }

  settingsBag.model = model;
  settingsBag.effortLevel = getOmpDefaultReasoningValue(model, settingsBag);
}

function applyOmpModelProjectionDefaults(model: string, settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return;
  }

  const settingsBag = settings as Record<string, unknown>;
  const preferredThinkingLevel = getOmpProviderSettings(settingsBag).preferredThinkingByModel[model];
  if (preferredThinkingLevel) {
    settingsBag.effortLevel = preferredThinkingLevel;
  }
}

function getOmpDefaultReasoningValue(model: string, settings: Record<string, unknown>): string {
  const ompModel = getCachedModel(model, settings);
  if (!ompModel) {
    return decodeOmpModelId(model) ? OMP_DEFAULT_THINKING_LEVEL : 'off';
  }

  const ompSettings = getOmpProviderSettings(settings);
  return clampOmpThinkingLevel(
    ompSettings.preferredThinkingByModel[ompModel.encodedId],
    ompModel.thinkingLevels,
  );
}

function buildModelOption(model: OmpDiscoveredModel, alias: string | undefined): ProviderUIOption {
  return {
    description: `${model.provider} runtime`,
    group: model.provider,
    label: alias ?? model.label,
    value: model.encodedId,
  };
}

function pushOption(
  target: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }

  seenValues.add(value);
  target.push(option);
}
