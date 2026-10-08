import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryInput,
  ProviderHistoryResult,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  buildPersistedDshProviderState,
  parseDshProviderState,
} from '../types';

const DSH_PROVIDER_STATE_KEYS = [
  'nativeConversationContextEstablished',
] as const;

/**
 * dsh stores transcripts as zstd-compressed v4 JSONL under
 * `$DSH_HOME/sessions/<cwd>/<sessionId>/`; that event schema is not public, so
 * this service never reads native files. Resume works through `session/resume`
 * with the persisted session id alone; hydration returns the repository-owned
 * conversation unchanged.
 */
export class DshConversationHistoryService implements ProviderConversationHistoryService {

  hydrateConversationHistory(
    input: ProviderHistoryInput,
  ): Promise<ProviderHistoryUpdate> {
    return Promise.resolve(copyProviderHistoryState(input));
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  async resolveMissingConversationSession(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    missingProviderSessionId?: string,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>> {
    const conversation = copyProviderHistoryState(input);
    if (
      !conversation.sessionId
      || !missingProviderSessionId
      || conversation.sessionId !== missingProviderSessionId
    ) {
      return { outcome: 'preserve' };
    }

    const providerState = { ...conversation.providerState };
    for (const key of DSH_PROVIDER_STATE_KEYS) delete providerState[key];
    conversation.sessionId = null;
    conversation.providerState = Object.keys(providerState).length > 0
      ? providerState
      : undefined;
    return { outcome: 'reset', changes: conversation };
  }

  isPendingForkConversation(_conversation: ProviderHistoryInput): boolean {
    // dsh has no session fork; nothing is ever pending a fork.
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    // Unreachable while capabilities.supportsFork is false; the interface
    // requires the method, so fail safe with empty state.
    return {};
  }

  buildPersistedProviderState(
    conversation: ProviderHistoryInput,
  ): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      DSH_PROVIDER_STATE_KEYS,
      buildPersistedDshProviderState(
        parseDshProviderState(conversation.providerState),
      ) as Record<string, unknown> | undefined,
    );
  }
}
