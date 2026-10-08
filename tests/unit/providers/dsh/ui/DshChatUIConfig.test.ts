import { dshModelPolicy } from '@/providers/dsh/DshModelPolicy';
import { dshChatUIConfig } from '@/providers/dsh/ui/DshChatUIConfig';
import { DSH_PROVIDER_ICON } from '@/shared/icons';

const flashRawId = '["deepseek-official","deepseek-v4-flash"]';
const codeRawId = '["deepseek-official","deepseek-v4-code"]';

const catalog = {
  defaultModelId: flashRawId,
  fingerprint: 'catalog-fingerprint',
  models: [
    {
      description: 'DeepSeek Flash',
      displayName: 'DeepSeek Flash',
      rawId: flashRawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    },
    {
      description: 'DeepSeek Code',
      displayName: 'DeepSeek Code',
      rawId: codeRawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    },
  ],
  refreshedAt: 100,
};

function makeSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerConfigs: {
      dsh: {
        catalogsByHost: {
          'device:current': catalog,
        },
        modelAliases: {
          [flashRawId]: 'Fast Flash',
        },
        visibleModels: [flashRawId],
      },
    },
    ...overrides,
  };
}

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'device:current',
}));

describe('DshChatUIConfig', () => {
  it('owns only dsh:-qualified model ids and resolves the enabled default', () => {
    expect(dshChatUIConfig.ownsModel('dsh', {})).toBe(false);
    expect(dshChatUIConfig.ownsModel(`dsh:${flashRawId}`, makeSettings())).toBe(true);
    expect(dshChatUIConfig.ownsModel(`dsh:${codeRawId}`, makeSettings())).toBe(true);
    expect(dshChatUIConfig.ownsModel('dsh:', {})).toBe(false);
    expect(dshChatUIConfig.ownsModel(flashRawId, {})).toBe(false);
    expect(dshChatUIConfig.getDefaultModel?.({})).toBeNull();
    expect(dshChatUIConfig.getDefaultModel?.(makeSettings())).toBe(`dsh:${flashRawId}`);
    expect(dshChatUIConfig.getProviderIcon?.()).toBe(DSH_PROVIDER_ICON);
  });

  it('exposes only discovered models and applies visibility and aliases', () => {
    expect(dshChatUIConfig.getModelOptions(makeSettings())).toEqual([
      expect.objectContaining({
        description: 'DeepSeek Flash',
        label: 'Fast Flash',
        value: `dsh:${flashRawId}`,
      }),
    ]);

    expect(dshChatUIConfig.getModelOptions(makeSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: null,
        },
      },
    })).map(option => option.value)).toEqual([
      `dsh:${flashRawId}`,
      `dsh:${codeRawId}`,
    ]);
  });

  it('labels JSON route/model raw ids by their model part', () => {
    const models = [
      { displayName: flashRawId, rawId: flashRawId, reasoningEfforts: [], supportsReasoning: false },
      { displayName: 'DeepSeek Code', rawId: codeRawId, reasoningEfforts: [], supportsReasoning: false },
    ];

    expect(dshChatUIConfig.getModelOptions(makeSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': { ...catalog, models } },
          visibleModels: null,
        },
      },
    })).map(option => option.label)).toEqual([
      'deepseek-v4-flash',
      'DeepSeek Code',
    ]);
  });

  it('does not expose active or saved selections that the user disabled', () => {
    const options = dshChatUIConfig.getModelOptions(makeSettings({
      model: `dsh:${codeRawId}`,
      savedProviderModel: { dsh: `dsh:${codeRawId}` },
    }));

    expect(options.map(option => option.value)).toEqual([`dsh:${flashRawId}`]);
  });

  it('does not expose a disabled title-generation selection', () => {
    const options = dshChatUIConfig.getModelOptions(makeSettings({
      titleGenerationModel: `dsh:${codeRawId}`,
    }));

    expect(options.map(option => option.value)).toEqual([`dsh:${flashRawId}`]);
  });

  it('uses the first enabled model when the native catalog default is disabled', () => {
    const settings = makeSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: [codeRawId],
        },
      },
    });

    expect(dshChatUIConfig.getDefaultModel?.(settings)).toBe(`dsh:${codeRawId}`);
    expect(dshChatUIConfig.getModelOptions(settings).map(option => option.value))
      .toEqual([`dsh:${codeRawId}`]);
  });

  it('uses the first explicitly ordered model even when the native default remains enabled', () => {
    const settings = makeSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: [codeRawId, flashRawId],
        },
      },
    });

    expect(dshChatUIConfig.getDefaultModel?.(settings)).toBe(`dsh:${codeRawId}`);
    expect(dshChatUIConfig.getModelOptions(settings).map(option => option.value)).toEqual([
      `dsh:${codeRawId}`,
      `dsh:${flashRawId}`,
    ]);
  });

  it('has no default or options when the user enables no models', () => {
    const settings = makeSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': catalog },
          visibleModels: [],
        },
      },
    });

    expect(dshChatUIConfig.getDefaultModel?.(settings)).toBeNull();
    expect(dshChatUIConfig.getModelOptions(settings)).toEqual([]);
  });

  it('normalizes explicit ids without replacing hidden current selections', () => {
    const settings = makeSettings({ model: `dsh:${codeRawId}` });

    expect(dshChatUIConfig.normalizeModelVariant(` dsh:${codeRawId} `, settings))
      .toBe(`dsh:${codeRawId}`);
    expect(dshChatUIConfig.normalizeModelVariant('dsh', settings)).toBe('dsh');
    expect(dshChatUIConfig.normalizeModelVariant('claude', settings)).toBe('claude');
  });

  it('offers only Ask and Accept edits permission modes and no mode selector', () => {
    const options = dshChatUIConfig.getPermissionModeOptions?.({}) ?? [];

    expect(options.map(option => option.value)).toEqual([
      'normal', 'acceptEdits',
    ]);
    expect(dshModelPolicy.permissionModes).toEqual(expect.objectContaining({
      fallbackValue: 'normal',
      values: options.map(option => option.value),
    }));
    expect(dshChatUIConfig.getModeSelector?.({})).toBeNull();
  });
});
