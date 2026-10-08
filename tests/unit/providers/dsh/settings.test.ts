const mockGetHostnameKey = jest.fn(() => 'device:current');

import {
  getCurrentDshCatalog,
  getDshProviderSettings,
  normalizeDshCatalogSnapshot,
  updateCurrentDshCatalog,
  updateDshProviderSettings,
} from '@/providers/dsh/settings';
import {
  buildPersistedDshProviderState,
  parseDshProviderState,
} from '@/providers/dsh/types';

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => mockGetHostnameKey(),
}));

describe('Dsh settings', () => {
  const currentCatalog = {
    defaultModelId: 'kimi-coding',
    fingerprint: 'fingerprint-current',
    models: [{
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }],
    refreshedAt: 100,
  };
  const otherCatalog = {
    defaultModelId: 'glm-coding',
    fingerprint: 'fingerprint-other',
    models: [{
      displayName: 'GLM Coding',
      rawId: 'glm-coding',
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 50,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetHostnameKey.mockReturnValue('device:current');
  });

  it('preserves hostname-scoped state without assigning it to the current device', () => {
    const settings = getDshProviderSettings({
      providerConfigs: {
        dsh: {
          catalogsByHost: {
            'legacy-host': currentCatalog,
            'other-host': otherCatalog,
          },
          cliPathsByHost: {
            'legacy-host': '/legacy/dsh',
            'other-host': '/other/dsh',
          },
        },
      },
    });

    expect(settings.cliPathsByHost).toEqual({
      'legacy-host': '/legacy/dsh',
      'other-host': '/other/dsh',
    });
    expect(settings.catalogsByHost).toEqual({
      'legacy-host': currentCatalog,
      'other-host': otherCatalog,
    });
    expect(settings.currentCatalog).toBeNull();
  });

  it('rejects arrays and filters mixed hostname CLI maps', () => {
    expect(getDshProviderSettings({
      providerConfigs: {
        dsh: {
          cliPathsByHost: ['/array/dsh'],
        },
      },
    }).cliPathsByHost).toEqual({});
    expect(getDshProviderSettings({
      providerConfigs: {
        dsh: {
          cliPathsByHost: {
            ' device:current ': ' /current/dsh ',
            invalid: 42,
          },
        },
      },
    }).cliPathsByHost).toEqual({ 'device:current': '/current/dsh' });
  });

  it('round-trips only the current host catalog without changing other hosts', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        dsh: {
          catalogsByHost: {
            'device:current': currentCatalog,
            'other-host': otherCatalog,
          },
        },
      },
    };
    const replacement = {
      ...currentCatalog,
      fingerprint: 'replacement',
      refreshedAt: 200,
    };

    expect(updateCurrentDshCatalog(settings, replacement)).toEqual(replacement);
    expect(getCurrentDshCatalog(settings)).toEqual(replacement);
    expect(getDshProviderSettings(settings).catalogsByHost['other-host']).toEqual(otherCatalog);
  });

  it('whitelists catalog metadata and never persists opaque or secret fields', () => {
    const snapshot = normalizeDshCatalogSnapshot({
      apiKey: 'catalog-secret',
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        accessToken: 'model-secret',
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
      }],
      refreshedAt: 123,
    });

    expect(snapshot).toEqual({
      defaultModelId: 'kimi-coding',
      fingerprint: 'names-only-fingerprint',
      models: [{
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
        reasoningEfforts: [],
        supportsReasoning: false,
      }],
      refreshedAt: 123,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('round-trips future provider-advertised effort metadata and preferences', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        dsh: {
          catalogsByHost: {
            'device:current': {
              defaultModelId: 'dsh-future',
              fingerprint: 'future-catalog',
              models: [{
                defaultReasoningEffort: 'max',
                displayName: 'Dsh Future',
                rawId: 'dsh-future',
                reasoningEfforts: [
                  { label: 'High', value: 'high' },
                  { label: 'Maximum', value: 'max' },
                ],
                reasoningMetadataResolved: true,
                supportsReasoning: true,
              }],
              refreshedAt: 123,
            },
          },
          preferredReasoningByModel: { 'dsh-future': 'max' },
          visibleModels: ['dsh-future'],
        },
      },
    };

    const dsh = getDshProviderSettings(settings);
    expect(dsh.currentCatalog?.models[0]).toEqual(expect.objectContaining({
      defaultReasoningEffort: 'max',
      reasoningEfforts: expect.arrayContaining([
        expect.objectContaining({ value: 'max' }),
      ]),
      reasoningMetadataResolved: true,
    }));
    expect(dsh.preferredReasoningByModel).toEqual({ 'dsh-future': 'max' });
  });

  it('normalizes catalog-scoped preferences while retaining a selected stale model', () => {
    const settings = getDshProviderSettings({
      model: 'dsh:legacy-model',
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'device:current': currentCatalog },
          modelAliases: {
            ' kimi-coding ': ' Kimi ',
            'legacy-model': ' Legacy ',
            unknown: 'Drop me',
          },
          preferredReasoningByModel: {
            'kimi-coding': 'medium',
            'legacy-model': 'low',
            unknown: 'xhigh',
          },
          visibleModels: [
            'kimi-coding',
            'kimi-coding',
            'legacy-model',
            'unknown',
          ],
        },
      },
    });

    expect(settings.visibleModels).toEqual(['kimi-coding', 'legacy-model', 'unknown']);
    expect(settings.modelAliases).toEqual({
      'kimi-coding': 'Kimi',
      'legacy-model': 'Legacy', unknown: 'Drop me',
    });
    expect(settings.preferredReasoningByModel).toEqual({
      'kimi-coding': 'medium',
      'legacy-model': 'low',
      unknown: 'xhigh',
    });
  });

  it('persists normalized settings without clobbering unrelated providers', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true },
        dsh: { catalogsByHost: { 'device:current': currentCatalog } },
      },
    };

    const next = updateDshProviderSettings(settings, {
      cliPath: ' /opt/bin/dsh ',
      enabled: true,
      modelAliases: { 'kimi-coding': ' Kimi ' },
      visibleModels: ['kimi-coding'],
    });

    expect(next).toMatchObject({
      cliPath: '',
      cliPathsByHost: { 'device:current': '/opt/bin/dsh' },
      enabled: true,
      modelAliases: { 'kimi-coding': 'Kimi' },
      visibleModels: ['kimi-coding'],
    });
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({ enabled: true });
  });

  it('prunes disabled preferences while retaining discovered capabilities in memory', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        dsh: {
          catalogsByHost: {
            'device:current': {
              ...currentCatalog,
              models: currentCatalog.models.map(model => ({
                ...model,
                reasoningMetadataResolved: true,
              })),
            },
            'device:other': {
              ...otherCatalog,
              models: otherCatalog.models.map(model => ({
                ...model,
                reasoningEfforts: [{ label: 'High', value: 'high' }],
                reasoningMetadataResolved: true,
                supportsReasoning: true,
              })),
            },
          },
          preferredReasoningByModel: { 'kimi-coding': 'high' },
          visibleModels: ['kimi-coding'],
        },
      },
    };

    updateDshProviderSettings(settings, { visibleModels: [] });

    const dsh = getDshProviderSettings(settings);
    expect(dsh.preferredReasoningByModel).toEqual({});
    for (const catalogSnapshot of Object.values(dsh.catalogsByHost)) {
      for (const model of catalogSnapshot.models) {
        expect(model.reasoningEfforts).toEqual([{ label: 'High', value: 'high' }]);
        expect(model.supportsReasoning).toBe(true);
        expect(model.reasoningMetadataResolved).toBe(true);
      }
    }
  });
});

describe('Dsh provider state', () => {
  it('preserves the provider-owned native-context handoff marker', () => {
    expect(parseDshProviderState({
      nativeConversationContextEstablished: false,
    })).toEqual({
      nativeConversationContextEstablished: false,
    });
    expect(buildPersistedDshProviderState({
      nativeConversationContextEstablished: true,
    })).toEqual({
      nativeConversationContextEstablished: true,
    });
  });

  it('drops unknown and invalid provider state fields', () => {
    expect(parseDshProviderState({
      nativeConversationContextEstablished: 'yes',
      token: 'do-not-preserve',
    })).toEqual({});
    expect(parseDshProviderState(null)).toEqual({});
    expect(parseDshProviderState({ nativeConversationContextEstablished: undefined })).toEqual({});
    expect(buildPersistedDshProviderState({
      nativeConversationContextEstablished: 'yes' as unknown as boolean,
    })).toBeUndefined();
    expect(buildPersistedDshProviderState({})).toBeUndefined();
  });
});
