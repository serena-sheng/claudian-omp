import type { Conversation } from '@/core/types';
import { DshConversationHistoryService } from '@/providers/dsh/history/DshConversationHistoryService';

function createConversation(): Conversation {
  return {
    createdAt: 1,
    id: 'conversation-1',
    lastActivityAt: 2,
    messages: [
      { content: 'question', id: 'user-1', role: 'user', timestamp: 1 },
      { content: 'answer', id: 'assistant-1', role: 'assistant', timestamp: 2 },
    ],
    model: 'dsh:dsh-4',
    provider: 'dsh',
    providerState: {
      nativeConversationContextEstablished: true,
      unknownKey: { retained: true },
    },
    resumeAtMessageId: 'assistant-1',
    sessionId: 'session-1',
    title: 'Conversation',
    updatedAt: 2,
  } as unknown as Conversation;
}

describe('DshConversationHistoryService', () => {
  const service = new DshConversationHistoryService();

  it('hydrates by returning the repository-owned conversation unchanged', async () => {
    const conversation = createConversation();

    const update = await service.hydrateConversationHistory(conversation);

    expect(update).toEqual({
      messages: conversation.messages,
      providerState: conversation.providerState,
      resumeAtMessageId: conversation.resumeAtMessageId,
      sessionId: conversation.sessionId,
    });
    expect(update).not.toBe(conversation);
  });

  it('resolves the native session id directly from the conversation', () => {
    expect(service.resolveSessionIdForConversation(createConversation())).toBe('session-1');
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
    expect(service.resolveSessionIdForConversation({
      ...createConversation(),
      sessionId: null,
    })).toBeNull();
  });

  describe('resolveMissingConversationSession', () => {
    it('preserves the conversation when no provider session is reported missing', async () => {
      await expect(service.resolveMissingConversationSession(
        createConversation(),
        '/tmp/vault',
      )).resolves.toEqual({ outcome: 'preserve' });
    });

    it('preserves the conversation when a different session is reported missing', async () => {
      await expect(service.resolveMissingConversationSession(
        createConversation(),
        '/tmp/vault',
        'session-other',
      )).resolves.toEqual({ outcome: 'preserve' });
    });

    it('resets the session and drops owned provider state when the session is missing', async () => {
      const result = await service.resolveMissingConversationSession(
        createConversation(),
        '/tmp/vault',
        'session-1',
      );

      expect(result).toEqual({
        changes: expect.objectContaining({
          providerState: { unknownKey: { retained: true } },
          sessionId: null,
        }),
        outcome: 'reset',
      });
    });

    it('clears provider state entirely when only owned keys remain', async () => {
      const conversation = createConversation();
      conversation.providerState = { nativeConversationContextEstablished: true };

      const result = await service.resolveMissingConversationSession(
        conversation,
        '/tmp/vault',
        'session-1',
      );

      expect(result).toEqual({
        changes: expect.objectContaining({
          providerState: undefined,
          sessionId: null,
        }),
        outcome: 'reset',
      });
    });
  });

  it('never treats a conversation as pending a fork', () => {
    expect(service.isPendingForkConversation(createConversation())).toBe(false);
  });

  it('builds empty fork provider state', () => {
    expect(service.buildForkProviderState()).toEqual({});
  });

  describe('buildPersistedProviderState', () => {
    it('keeps only the owned key and preserves unknown state', () => {
      expect(service.buildPersistedProviderState(createConversation())).toEqual({
        nativeConversationContextEstablished: true,
        unknownKey: { retained: true },
      });
    });

    it('returns undefined when no persistable state remains', () => {
      expect(service.buildPersistedProviderState({
        ...createConversation(),
        providerState: { nativeConversationContextEstablished: undefined },
      })).toBeUndefined();
    });

    it('drops an invalid owned value while keeping unknown state', () => {
      expect(service.buildPersistedProviderState({
        ...createConversation(),
        providerState: {
          nativeConversationContextEstablished: 'yes',
          unknownKey: 1,
        },
      })).toEqual({ unknownKey: 1 });
    });
  });
});
