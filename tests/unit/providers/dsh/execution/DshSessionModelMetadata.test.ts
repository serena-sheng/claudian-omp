import {
  normalizeDshModelUpdateMetadata,
  normalizeDshSessionModelMetadata,
  normalizeDshSetModelMetadata,
} from '@/providers/dsh/execution/DshSessionModelMetadata';

const flashRawId = '["deepseek-official","deepseek-v4-flash"]';
const codeRawId = '["deepseek-official","deepseek-v4-code"]';

describe('DshSessionModelMetadata', () => {
  it('extracts grouped model options whose values are JSON route/model pairs', () => {
    const result = normalizeDshSessionModelMetadata({
      configOptions: [{
        category: 'model',
        currentValue: flashRawId,
        id: 'model',
        name: 'Model',
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek Official',
            options: [
              { name: 'Flash', value: flashRawId },
              { name: 'Code', value: codeRawId },
            ],
          },
          {
            group: 'other',
            name: 'Other',
            options: [
              { name: 'Other Model', value: '["other","other-model"]' },
            ],
          },
        ],
        type: 'select',
      }],
    });

    expect(result.currentModelId).toBe(flashRawId);
    expect(result.models).toEqual([
      expect.objectContaining({ displayName: 'Flash', rawId: flashRawId }),
      expect.objectContaining({ displayName: 'Code', rawId: codeRawId }),
      expect.objectContaining({ displayName: 'Other Model', rawId: '["other","other-model"]' }),
    ]);
    expect(result.models).toHaveLength(3);
    expect(result.models.every(model => model.reasoningEfforts.length === 0)).toBe(true);
  });

  it('merges per-model ACP metadata without leaking reasoning effort state', () => {
    const result = normalizeDshSessionModelMetadata({
      configOptions: [{
        category: 'model',
        currentValue: flashRawId,
        id: 'model',
        name: 'Model',
        options: [{ name: 'Flash', value: flashRawId }],
        type: 'select',
      }],
      models: {
        availableModels: [{
          _meta: {
            agentType: 'dsh-build-plan',
            totalContextTokens: 200_000,
          },
          modelId: flashRawId,
          name: 'Flash',
        }],
        currentModelId: flashRawId,
      },
    });

    expect(result.models).toEqual([
      expect.objectContaining({
        agentType: 'dsh-build-plan',
        contextWindow: 200_000,
        displayName: 'Flash',
        rawId: flashRawId,
        reasoningEfforts: [],
        supportsReasoning: false,
      }),
    ]);
    expect(result.models[0]).not.toHaveProperty('defaultReasoningEffort');
    expect(result.models[0]).not.toHaveProperty('reasoningMetadataResolved');
  });

  it('attaches the requested model id to set-model metadata', () => {
    expect(normalizeDshSetModelMetadata(flashRawId, {
      model: {
        displayName: 'Flash',
      },
    })).toEqual(expect.objectContaining({
      displayName: 'Flash',
      rawId: flashRawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }));
  });

  it('normalizes direct and wrapped ACP model update payloads', () => {
    const state = {
      availableModels: [{
        modelId: flashRawId,
        name: 'Flash',
      }],
      currentModelId: flashRawId,
    };

    expect(normalizeDshModelUpdateMetadata(state)).toEqual(expect.objectContaining({
      currentModelId: flashRawId,
      models: [expect.objectContaining({
        rawId: flashRawId,
        reasoningEfforts: [],
      })],
    }));
    expect(normalizeDshModelUpdateMetadata({ models: state }))
      .toEqual(normalizeDshModelUpdateMetadata(state));
    expect(normalizeDshModelUpdateMetadata({ invalid: true })).toBeNull();
  });
});
