import {
  decodeDshModelId,
  encodeDshModelId,
  findDshModel,
  getDshAvailableReasoningEfforts,
  isDshModelSelectionId,
  mergeDshDiscoveredModels,
  normalizeDshDiscoveredModels,
  resolveDshDefaultReasoningEffort,
} from '@/providers/dsh/models';

describe('Dsh model identity', () => {
  it('round-trips JSON-encoded raw model ids through the dsh: prefix', () => {
    const rawId = '["deepseek-official","deepseek-v4-flash"]';
    expect(encodeDshModelId(rawId)).toBe(`dsh:${rawId}`);
    expect(encodeDshModelId(`dsh:${rawId}`)).toBe(`dsh:${rawId}`);
    expect(encodeDshModelId('')).toBe('');
    expect(encodeDshModelId('dsh:')).toBe('');
    expect(decodeDshModelId(`dsh:${rawId}`)).toBe(rawId);
    expect(decodeDshModelId('dsh')).toBeNull();
    expect(decodeDshModelId(` dsh:${rawId} `)).toBe(rawId);
    expect(isDshModelSelectionId('dsh')).toBe(false);
    expect(isDshModelSelectionId(`dsh:${rawId}`)).toBe(true);
    expect(isDshModelSelectionId('dsh:')).toBe(false);
    expect(isDshModelSelectionId(rawId)).toBe(false);
  });
});

describe('Dsh model metadata', () => {
  it('normalizes only non-secret persisted metadata', () => {
    expect(normalizeDshDiscoveredModels([{
      agentType: ' coding ',
      apiKey: 'must-not-persist',
      contextWindow: 262_144,
      defaultReasoningEffort: ' high ',
      description: ' Fast custom model ',
      displayName: ' Kimi Coding ',
      rawId: ' kimi-coding ',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: ' Low ', value: ' low ' },
        { value: 'high' },
        { value: 'high' },
      ],
      supportsReasoning: true,
    }])).toEqual([{
      agentType: 'coding',
      contextWindow: 262_144,
      defaultReasoningEffort: 'high',
      description: 'Fast custom model',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningMetadataResolved: true,
      reasoningEfforts: [
        { description: 'Quick', label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    }]);
  });

  it('normalizes dsh wire reasoning metadata from the reasoningEfforts array', () => {
    expect(normalizeDshDiscoveredModels([{
      modelId: '["deepseek-official","deepseek-v4-flash"]',
      name: 'DeepSeek Flash',
      reasoningEffort: 'high',
      reasoningEfforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' },
      ],
      supportsReasoningEffort: true,
    }])).toEqual([expect.objectContaining({
      defaultReasoningEffort: 'high',
      rawId: '["deepseek-official","deepseek-v4-flash"]',
      reasoningEfforts: [
        { label: 'Low', value: 'low' },
        { label: 'High', value: 'high' },
      ],
      supportsReasoning: true,
    })]);
  });

  it('merges live metadata by raw id while retaining prior catalog-only fields', () => {
    const merged = mergeDshDiscoveredModels(
      [{
        displayName: 'Kimi',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }, {
        displayName: 'GLM',
        rawId: 'glm-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      [{
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [
          { label: 'Low', value: 'low' },
          { label: 'High', value: 'high' },
        ],
        supportsReasoning: true,
      }],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        agentType: 'coding',
        contextWindow: 200_000,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        supportsReasoning: true,
      }),
      expect.objectContaining({ rawId: 'glm-coding' }),
    ]);
    expect(findDshModel(merged, 'dsh:kimi-coding')?.contextWindow).toBe(200_000);
  });

  it('treats resolved ACP reasoning metadata as authoritative', () => {
    const [merged] = mergeDshDiscoveredModels([{
      defaultReasoningEffort: 'high',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }], [{
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    }]);

    expect(merged).toEqual({
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: [],
      reasoningMetadataResolved: true,
      supportsReasoning: false,
    });
  });

  it('returns no reasoning efforts when the model publishes none', () => {
    const unresolved = {
      displayName: 'Unresolved',
      rawId: 'unresolved',
      reasoningEfforts: [],
      supportsReasoning: false,
    };
    const withEfforts = {
      ...unresolved,
      displayName: 'Resolved',
      rawId: 'resolved',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
    };

    expect(getDshAvailableReasoningEfforts(unresolved)).toEqual([]);
    expect(getDshAvailableReasoningEfforts(withEfforts)).toEqual([
      { label: 'High', value: 'high' },
    ]);
    expect(getDshAvailableReasoningEfforts(undefined)).toEqual([]);
  });

  it('preserves explicit preferences and always defaults to High', () => {
    const model = normalizeDshDiscoveredModels([{
      defaultReasoningEffort: 'medium',
      displayName: 'Reasoner',
      rawId: 'reasoner',
      reasoningEfforts: ['low', 'medium', 'high'],
      supportsReasoning: true,
    }])[0];

    expect(resolveDshDefaultReasoningEffort(model, 'low')).toBe('low');
    expect(resolveDshDefaultReasoningEffort(model)).toBe('high');
    expect(resolveDshDefaultReasoningEffort({
      ...model,
      reasoningMetadataResolved: true,
    })).toBe('high');
    expect(resolveDshDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
    })).toBe('high');
    expect(resolveDshDefaultReasoningEffort({
      ...model,
      defaultReasoningEffort: undefined,
      reasoningEfforts: [{ label: 'Low', value: 'low' }],
    })).toBe('high');
  });

});
