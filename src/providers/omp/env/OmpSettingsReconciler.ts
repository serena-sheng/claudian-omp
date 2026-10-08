import { getInstallationKey } from '@/core/device/InstallationKey';
import { parseEnvironmentVariables } from '@/core/process/env';

import {
  type CLIPathFingerprintInputs,
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '../../../core/providers/cli/CLIPathFingerprintInputs';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
} from '../../../core/providers/settings/RuntimeInputFingerprint';
import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import {
  getOmpProviderSettings,
  updateOmpProviderSettings
} from '../settings';
import { clearOmpResumeState } from '../types';

const LEGACY_OMP_ENV_HASH_KEYS = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_CACHE_RETENTION',
] as const;

const OMP_ENV_HASH_KEYS = [
  ...LEGACY_OMP_ENV_HASH_KEYS,
  'PATH',
] as const;

function computeOmpRuntimeFingerprint(
  environmentText: string,
  cliPathInputs: CLIPathFingerprintInputs,
): string {
  return createRuntimeInputFingerprint({
    additionalInputs: cliPathInputs,
    environmentKeys: OMP_ENV_HASH_KEYS,
    environmentText,
  });
}

function invalidateOmpConversationSessions(conversations: Conversation[]): Conversation[] {
  return conversations.filter(conversation => (
    conversation.providerId === 'omp' && clearOmpResumeState(conversation)
  ));
}

function isCurrentLegacyOmpFingerprint(
  environmentText: string,
  savedFingerprint: string,
  cliPathInputs: CLIPathFingerprintInputs,
): boolean {
  if (
    !savedFingerprint
    || isVersionedRuntimeInputFingerprint(savedFingerprint)
    || hasCLIPathFingerprintInputs(cliPathInputs)
  ) {
    return false;
  }

  const environment = parseEnvironmentVariables(environmentText);
  const legacyFingerprint = LEGACY_OMP_ENV_HASH_KEYS
    .filter(key => environment[key])
    .map(key => `${key}=${environment[key]}`)
    .sort()
    .join('|');
  return savedFingerprint === legacyFingerprint;
}

export const ompSettingsReconciler = {

  invalidateConversationSessions: invalidateOmpConversationSessions,

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const envText = getRuntimeEnvironmentText(settings, 'omp');
    const ompSettings = getOmpProviderSettings(settings);
    const cliPathInputs = createCLIPathFingerprintInputs(
      ompSettings.cliPathsByHost[getInstallationKey()],
      ompSettings.cliPath,
    );
    const currentHash = computeOmpRuntimeFingerprint(envText, cliPathInputs);
    const savedHash = ompSettings.environmentHash;

    const environment = parseEnvironmentVariables(envText);
    const hasFingerprintInputs = Boolean(
      hasCLIPathFingerprintInputs(cliPathInputs)
      || OMP_ENV_HASH_KEYS.some(key => Object.prototype.hasOwnProperty.call(environment, key))
    );
    if (!savedHash && !hasFingerprintInputs) {
      return { changed: false, invalidatedConversations: [] };
    }
    if (currentHash === savedHash) {
      return { changed: false, invalidatedConversations: [] };
    }

    const invalidatedConversations = invalidateOmpConversationSessions(conversations);

    updateOmpProviderSettings(settings, { environmentHash: currentHash });
    return { changed: true, invalidatedConversations };
  },

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean {
    const ompSettings = getOmpProviderSettings(settings);
    let changed = false;

    const envText = getRuntimeEnvironmentText(settings, 'omp');
    const cliPathInputs = createCLIPathFingerprintInputs(
      ompSettings.cliPathsByHost[getInstallationKey()],
      ompSettings.cliPath,
    );
    if (isCurrentLegacyOmpFingerprint(
      envText,
      ompSettings.environmentHash,
      cliPathInputs,
    )) {
      updateOmpProviderSettings(settings, {
        environmentHash: computeOmpRuntimeFingerprint(envText, cliPathInputs),
      });
      changed = true;
    }

    return changed;
  },
} satisfies ProviderSettingsReconciler;
