import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import {
  computeDshEnvironmentHash,
  dshSettingsReconciler,
} from '@/providers/dsh/env/DshSettingsReconciler';
import { getDshProviderSettings } from '@/providers/dsh/settings';

jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'current-host',
}));

describe('DshSettingsReconciler', () => {
  const catalog = (rawId: string) => ({
    defaultModelId: rawId,
    fingerprint: `${rawId}-fingerprint`,
    models: [{
      displayName: rawId,
      rawId,
      reasoningEfforts: [],
      supportsReasoning: false,
    }],
    refreshedAt: 1,
  });

  it('computes a stable SHA-256 digest without exposing raw secret values', () => {
    const first = computeDshEnvironmentHash({
      providerConfigs: {
        dsh: {
          cliPathsByHost: { 'current-host': '/bin/dsh' },
          environmentVariables: 'XAI_API_KEY=super-secret\nDSH_HOME=/tmp/dsh',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });
    const reordered = computeDshEnvironmentHash({
      providerConfigs: {
        dsh: {
          cliPathsByHost: { 'current-host': '/bin/dsh' },
          environmentVariables: 'DSH_HOME=/tmp/dsh\nXAI_API_KEY=super-secret',
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    });

    expect(isVersionedRuntimeInputFingerprint(first)).toBe(true);
    expect(first).toBe(reordered);
    expect(first).not.toContain('super-secret');
    expect(first).not.toContain('/tmp/dsh');
  });

  it('fingerprints the legacy CLI fallback independently from the hostname candidate', () => {
    const createSettings = (legacyCliPath: string): Record<string, unknown> => ({
      providerConfigs: {
        dsh: {
          cliPath: legacyCliPath,
          cliPathsByHost: { 'current-host': '/missing/hostname-dsh' },
          environmentVariables: '',
        },
      },
    });

    expect(computeDshEnvironmentHash(createSettings('/bin/dsh-a'))).not.toBe(
      computeDshEnvironmentHash(createSettings('/bin/dsh-b')),
    );
  });

  it('declares reload and preserves all conversation bindings', () => {
    const dshConversation = {
      messages: [],
      providerId: 'dsh',
      providerState: { sessionDirectory: '/tmp/dsh/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;

    expect(dshSettingsReconciler.environmentSessionPolicy).toBe('reload');
    expect(dshSettingsReconciler.invalidateConversationSessions([dshConversation]))
      .toEqual([]);
    expect(dshConversation).toEqual(expect.objectContaining({
      providerState: { sessionDirectory: '/tmp/dsh/session-1' },
      sessionId: 'session-1',
    }));
  });

  it('leaves pristine disabled defaults untouched during startup reconciliation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        dsh: {
          catalogsByHost: {},
          enabled: false,
          environmentHash: '',
          environmentVariables: '',
        },
      },
    };

    expect(dshSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getDshProviderSettings(settings).environmentHash).toBe('');
  });

  it('retains the current host catalog when construction inputs become stale', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: { enabled: true, marker: 'untouched' },
        dsh: {
          catalogsByHost: {
            'current-host': catalog('current-model'),
            'other-host': catalog('other-model'),
          },
          enabled: true,
          environmentHash: 'stale-hash',
          environmentVariables: 'XAI_API_KEY=new-secret',
        },
      },
    };
    const dshConversation = {
      messages: [],
      providerId: 'dsh',
      providerState: { sessionDirectory: '/tmp/dsh/session-1' },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const otherConversation = {
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = dshSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [dshConversation, otherConversation],
    );

    expect(result).toEqual({ changed: true, invalidatedConversations: [] });
    expect(getDshProviderSettings(settings).catalogsByHost).toEqual({
      'current-host': catalog('current-model'),
      'other-host': catalog('other-model'),
    });
    expect(getDshProviderSettings(settings).environmentHash)
      .toBe(computeDshEnvironmentHash(settings));
    expect(dshConversation.sessionId).toBe('session-1');
    expect(otherConversation.sessionId).toBe('claude-session');
    expect((settings.providerConfigs as Record<string, unknown>).codex).toEqual({
      enabled: true,
      marker: 'untouched',
    });
  });

  it('retains the current catalog when the construction digest is current', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        dsh: {
          catalogsByHost: { 'current-host': catalog('current-model') },
          enabled: true,
          environmentVariables: 'DSH_HOME=/tmp/dsh',
        },
      },
    };
    (settings.providerConfigs as Record<string, any>).dsh.environmentHash =
      computeDshEnvironmentHash(settings);

    expect(dshSettingsReconciler.reconcileModelWithEnvironment(settings, []))
      .toEqual({ changed: false, invalidatedConversations: [] });
    expect(getDshProviderSettings(settings).currentCatalog).toEqual(catalog('current-model'));
  });

  it('normalizes qualified Dsh selections in every shared model slot', () => {
    const flash = '["deepseek-official","deepseek-v4-flash"]';
    const settings: Record<string, unknown> = {
      model: `  dsh:${flash}  `,
      titleGenerationModel: ' dsh:["deepseek-official","deepseek-v4-code"] ',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        dsh: ' dsh:["other","other-model"] ',
      },
    };

    expect(dshSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(true);
    expect(settings).toEqual({
      model: `dsh:${flash}`,
      titleGenerationModel: 'dsh:["deepseek-official","deepseek-v4-code"]',
      savedProviderModel: {
        claude: 'claude-sonnet-4-5',
        dsh: 'dsh:["other","other-model"]',
      },
    });
  });

  it('leaves normalized, unqualified, and unrelated provider selections unchanged', () => {
    const flash = '["deepseek-official","deepseek-v4-flash"]';
    const settings: Record<string, unknown> = {
      model: `dsh:${flash}`,
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        dsh: '["other","other-model"]',
      },
    };

    expect(dshSettingsReconciler.normalizeModelVariantSettings!(settings)).toBe(false);
    expect(settings).toEqual({
      model: `dsh:${flash}`,
      titleGenerationModel: 'claude-sonnet-4-5',
      savedProviderModel: {
        codex: 'gpt-5.4',
        dsh: '["other","other-model"]',
      },
    });
  });
});
