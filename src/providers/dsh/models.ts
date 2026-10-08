import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';

export interface DshReasoningEffort {
  description?: string;
  label: string;
  value: string;
}

export interface DshDiscoveredModel {
  agentType?: string;
  contextWindow?: number;
  defaultReasoningEffort?: string;
  description?: string;
  displayName: string;
  rawId: string;
  reasoningMetadataResolved?: boolean;
  reasoningEfforts: DshReasoningEffort[];
  supportsReasoning: boolean;
}

export const DSH_MODEL_PREFIX = 'dsh:';

/**
 * dsh model option values are JSON-encoded `[route, model]` pairs, e.g.
 * `["deepseek-official","deepseek-v4-flash"]`. The raw string must round-trip
 * verbatim (it is sent back as the `session/set_config_option` value); this
 * helper only reads it for display purposes.
 */
export function parseDshModelRouteValue(
  rawModelId: string,
): { model: string; route: string } | null {
  try {
    const parsed: unknown = JSON.parse(rawModelId);
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      return null;
    }
    const [route, model] = parsed as unknown[];
    if (typeof route !== 'string' || typeof model !== 'string' || !route || !model) {
      return null;
    }
    return { model, route };
  } catch {
    return null;
  }
}

export function isDshModelSelectionId(model: string): boolean {
  return decodeDshModelId(model.trim()) !== null;
}

export function encodeDshModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === DSH_MODEL_PREFIX) {
    return '';
  }
  return normalized.startsWith(DSH_MODEL_PREFIX)
    ? normalized
    : `${DSH_MODEL_PREFIX}${normalized}`;
}

export function decodeDshModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(DSH_MODEL_PREFIX)) {
    return null;
  }
  const rawModelId = normalized.slice(DSH_MODEL_PREFIX.length).trim();
  return rawModelId || null;
}

export function normalizeDshDiscoveredModels(value: unknown): DshDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedById = new Map<string, DshDiscoveredModel>();
  for (const entry of value) {
    const model = normalizeDshDiscoveredModel(entry);
    if (!model) {
      continue;
    }

    const current = normalizedById.get(model.rawId);
    normalizedById.set(
      model.rawId,
      current ? mergeDshModelMetadata(current, model) : model,
    );
  }
  return Array.from(normalizedById.values());
}

export function mergeDshDiscoveredModels(
  catalogModels: DshDiscoveredModel[],
  liveModels: DshDiscoveredModel[],
): DshDiscoveredModel[] {
  const merged = normalizeDshDiscoveredModels(catalogModels);
  const indexes = new Map(merged.map((model, index) => [model.rawId, index] as const));

  for (const incoming of normalizeDshDiscoveredModels(liveModels)) {
    const index = indexes.get(incoming.rawId);
    if (index === undefined) {
      indexes.set(incoming.rawId, merged.length);
      merged.push(incoming);
      continue;
    }
    merged[index] = mergeDshModelMetadata(merged[index], incoming);
  }

  return merged;
}

/** Native option names win; a `["route","model"]` value labels as its model part. */
export function getDshModelLabel(model: Pick<DshDiscoveredModel, 'displayName' | 'rawId'>): string {
  if (model.displayName !== model.rawId) {
    return model.displayName;
  }
  return parseDshModelRouteValue(model.rawId)?.model ?? model.rawId;
}

export function findDshModel(
  models: DshDiscoveredModel[],
  modelId: string,
): DshDiscoveredModel | null {
  const rawModelId = decodeDshModelId(modelId) ?? modelId.trim();
  if (!rawModelId) {
    return null;
  }
  return models.find(model => model.rawId === rawModelId) ?? null;
}

export function getDshAvailableReasoningEfforts(
  model: DshDiscoveredModel | null | undefined,
): readonly DshReasoningEffort[] {
  // dsh publishes no reasoning-effort metadata; never fabricate effort choices.
  return model?.reasoningEfforts ?? [];
}

export function resolveDshDefaultReasoningEffort(
  model: DshDiscoveredModel | null | undefined,
  preferredEffort?: string,
): string {
  const availableValues = model?.reasoningEfforts.map(effort => effort.value) ?? [];
  const normalizedPreferred = preferredEffort?.trim();
  if (normalizedPreferred && availableValues.includes(normalizedPreferred)) {
    return normalizedPreferred;
  }

  return DEFAULT_REASONING_VALUE;
}

export function normalizeDshReasoningMetadata(value: unknown): Pick<
  DshDiscoveredModel,
  'defaultReasoningEffort' | 'reasoningEfforts' | 'supportsReasoning'
> {
  if (!isRecord(value)) {
    return { reasoningEfforts: [], supportsReasoning: false };
  }
  const reasoningEfforts = normalizeDshReasoningEfforts(
    value.reasoningEfforts ?? value.reasoning_efforts,
  );
  const defaultReasoningEffort = readTrimmedString(
    value.reasoningEffort
      ?? value.reasoning_effort
      ?? value.defaultReasoningEffort
      ?? value.default_reasoning_effort,
  );
  const supportsReasoning = value.supportsReasoning === true
    || value.supports_reasoning === true
    || value.supportsReasoningEffort === true
    || value.supports_reasoning_effort === true
    || reasoningEfforts.length > 0
    || Boolean(defaultReasoningEffort);
  return {
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    reasoningEfforts,
    supportsReasoning,
  };
}

function normalizeDshDiscoveredModel(value: unknown): DshDiscoveredModel | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawId = readTrimmedString(value.rawId ?? value.modelId ?? value.id);
  if (!rawId) {
    return null;
  }

  const reasoning = normalizeDshReasoningMetadata(value);
  const agentType = readTrimmedString(value.agentType ?? value.agent_type);
  const contextWindow = readPositiveFiniteNumber(
    value.contextWindow
      ?? value.context_window
      ?? value.totalContextTokens
      ?? value.total_context_tokens,
  );
  const description = readTrimmedString(value.description);
  const displayName = readTrimmedString(
    value.displayName ?? value.display_name ?? value.name ?? value.label,
  ) || rawId;
  return {
    ...(agentType ? { agentType } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reasoning.defaultReasoningEffort
      ? { defaultReasoningEffort: reasoning.defaultReasoningEffort }
      : {}),
    ...(description ? { description } : {}),
    displayName,
    rawId,
    ...(value.reasoningMetadataResolved === true
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts: reasoning.reasoningEfforts,
    supportsReasoning: reasoning.supportsReasoning,
  };
}

function normalizeDshReasoningEfforts(value: unknown): DshReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts: DshReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    const effortValue = readTrimmedString(record?.value ?? record?.id ?? entry);
    if (!effortValue || seen.has(effortValue)) {
      continue;
    }
    seen.add(effortValue);
    const label = readTrimmedString(record?.label ?? record?.name)
      || formatReasoningValueLabel(effortValue);
    const description = readTrimmedString(record?.description);
    efforts.push({
      ...(description ? { description } : {}),
      label,
      value: effortValue,
    });
  }
  return efforts;
}

function mergeDshModelMetadata(
  current: DshDiscoveredModel,
  incoming: DshDiscoveredModel,
): DshDiscoveredModel {
  const incomingReasoningIsAuthoritative = incoming.reasoningMetadataResolved === true;
  const reasoningEfforts = incomingReasoningIsAuthoritative
    ? incoming.reasoningEfforts
    : incoming.reasoningEfforts.length > 0
      ? incoming.reasoningEfforts
      : current.reasoningEfforts;
  const defaultReasoningEffort = incomingReasoningIsAuthoritative
    ? incoming.defaultReasoningEffort
    : incoming.defaultReasoningEffort ?? current.defaultReasoningEffort;
  const incomingDisplayNameIsRich = incoming.displayName !== incoming.rawId;

  return {
    ...(incoming.agentType ?? current.agentType
      ? { agentType: incoming.agentType ?? current.agentType }
      : {}),
    ...(incoming.contextWindow ?? current.contextWindow
      ? { contextWindow: incoming.contextWindow ?? current.contextWindow }
      : {}),
    ...(defaultReasoningEffort
      ? { defaultReasoningEffort }
      : {}),
    ...(incoming.description ?? current.description
      ? { description: incoming.description ?? current.description }
      : {}),
    displayName: incomingDisplayNameIsRich ? incoming.displayName : current.displayName,
    rawId: current.rawId,
    ...(incoming.reasoningMetadataResolved || current.reasoningMetadataResolved
      ? { reasoningMetadataResolved: true }
      : {}),
    reasoningEfforts,
    supportsReasoning: incomingReasoningIsAuthoritative
      ? incoming.supportsReasoning || reasoningEfforts.length > 0
      : incoming.supportsReasoning
        || current.supportsReasoning
        || reasoningEfforts.length > 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveFiniteNumber(value: unknown): number | undefined {
  return isPositiveFiniteNumber(value) ? Math.floor(value) : undefined;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
