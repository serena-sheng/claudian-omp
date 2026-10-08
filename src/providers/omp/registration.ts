import { NOOP_TASK_RESULT_INTERPRETER } from '../../core/providers/NoopTaskResultInterpreter';
import { getProviderConfig } from '../../core/providers/providerConfig';
import { hasStoredConfigNormalization } from '../../core/providers/settings/storedSettings';
import type { ProviderModule } from '../../core/providers/types';
import {
  getOmpWorkspaceServices,
  ompWorkspaceRegistration,
} from './app/OmpWorkspaceServices';
import { OMP_PROVIDER_CAPABILITIES } from './capabilities';
import { ompSettingsReconciler } from './env/OmpSettingsReconciler';
import { OmpExecutionBackend } from './execution/OmpExecutionBackend';
import { OmpConversationHistoryService } from './history/OmpConversationHistoryService';
import { ompModelPolicy } from './OmpModelPolicy';
import { getOmpProviderSettings, projectOmpModelSettings, updateOmpProviderSettings } from './settings';
import { ObsidianOmpExtensionUIRenderer } from './ui/ObsidianOmpExtensionUIRenderer';
import { ompChatUIConfig } from './ui/OmpChatUIConfig';

export const ompProviderRegistration: ProviderModule = {
  id: 'omp',
  blankTabOrder: 13,
  capabilities: OMP_PROVIDER_CAPABILITIES,
  modelPolicy: ompModelPolicy,
  chatUIConfig: ompChatUIConfig,
  createExecutionBackend: (plugin) => new OmpExecutionBackend(
    plugin,
    getOmpWorkspaceServices(),
    { extensionUiRenderer: new ObsidianOmpExtensionUIRenderer(plugin.app) },
  ),

  displayName: 'OMP',
  environmentKeyPatterns: [/^OMP_/i],
  historyService: new OmpConversationHistoryService(),
  isEnabled: (settings) => getOmpProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateOmpProviderSettings(settings, { enabled }),
  settingsReconciler: ompSettingsReconciler,
  settingsStorage: {
    projectPersistedConfig: projectOmpModelSettings,
    needsReasoningMetadata(settings) {
      const current = getOmpProviderSettings(settings);
      return current.visibleModels.some(id => {
        const model = current.discoveredModels.find(model => model.encodedId === id);
        return !model || model.reasoningMetadataResolved === false;
      });
    },
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      const storedConfig = getProviderConfig(stored, 'omp');
      updateOmpProviderSettings(target, getOmpProviderSettings(stored));
      return hasStoredConfigNormalization(
        storedConfig,
        getProviderConfig(target, 'omp'),
      );
    },
  },
  taskResultInterpreter: NOOP_TASK_RESULT_INTERPRETER,
  workspace: ompWorkspaceRegistration,
};
