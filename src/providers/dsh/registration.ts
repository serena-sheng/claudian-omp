import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getDshWorkspaceServices,
  dshWorkspaceRegistration,
} from './app/DshWorkspaceServices';
import { DSH_PROVIDER_CAPABILITIES } from './capabilities';
import { dshSettingsReconciler } from './env/DshSettingsReconciler';
import { DshExecutionBackend } from './execution/DshExecutionBackend';
import { dshModelPolicy } from './DshModelPolicy';
import { DshConversationHistoryService } from './history/DshConversationHistoryService';
import { getDshMigratedVisibleModelIds, getDshProviderSettings, getOrderedDshVisibleModelIds, projectDshModelSettings, updateDshProviderSettings } from './settings';
import { dshChatUIConfig } from './ui/DshChatUIConfig';

export const dshProviderRegistration: ProviderModule = {
  id: 'dsh',
  blankTabOrder: 14,
  capabilities: DSH_PROVIDER_CAPABILITIES,
  modelPolicy: dshModelPolicy,
  chatUIConfig: dshChatUIConfig,
  createExecutionBackend: (plugin) => {
    const workspace = getDshWorkspaceServices();
    return new DshExecutionBackend(plugin, {
      commandCatalog: workspace.commandCatalog,
      modelCatalogCoordinator: workspace.modelCatalogCoordinator,
    });
  },

  displayName: 'DeepSeek Harness',
  environmentKeyPatterns: [/^DEEPSEEK_/i, /^DSH_/i],
  historyService: new DshConversationHistoryService(),
  isEnabled: settings => getDshProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateDshProviderSettings(settings, { enabled }),
  settingsReconciler: dshSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectDshModelSettings,
    needsReasoningMetadata(settings) {
      const current = getDshProviderSettings(settings);
      return getOrderedDshVisibleModelIds(current).some(id => {
        const model = current.currentCatalog?.models.find(model => model.rawId === id);
        return !model || (!model.reasoningEfforts.length && !model.reasoningMetadataResolved);
      });
    },
    hostScopedFields: ['cliPathsByHost', 'catalogsByHost', 'selectedModelsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'dsh');
      const current = getDshProviderSettings(stored);
      updateDshProviderSettings(target, { ...current, visibleModels: getDshMigratedVisibleModelIds(current) });
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'dsh'),
      );
    },
  },
  // dsh's subagent tool names/payloads are unverified; no lifecycle adapter is
  // registered rather than guessing Grok's.
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: dshWorkspaceRegistration,
};
