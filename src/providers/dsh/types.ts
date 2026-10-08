export interface DshProviderState {
  nativeConversationContextEstablished?: boolean;
}

export function parseDshProviderState(value: unknown): DshProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const nativeConversationContextEstablished = typeof record.nativeConversationContextEstablished
    === 'boolean'
    ? record.nativeConversationContextEstablished
    : undefined;
  return {
    ...(nativeConversationContextEstablished !== undefined
      ? { nativeConversationContextEstablished }
      : {}),
  };
}

export function buildPersistedDshProviderState(
  state: DshProviderState,
): DshProviderState | undefined {
  const persisted = parseDshProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
