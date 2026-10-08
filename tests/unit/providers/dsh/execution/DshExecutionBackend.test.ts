import { capturedSelectionPrompt, capturedSelections } from '@test/helpers/capturedSelections';
import { testDate } from '@test/helpers/testClock';

import type {
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderInteractionPort,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type {
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPSessionConfigOption,
  ACPSessionNotification,
} from '@/providers/acp';
import {
  DshExecutionBackend,
  type DshExecutionNativeConnection,
  type DshExecutionNativeCreateOptions,
  type DshExecutionNativeFactory,
} from '@/providers/dsh/execution/DshExecutionBackend';
import type { DshDiscoveredModel } from '@/providers/dsh/models';
import {
  updateCurrentDshCatalog,
  updateDshProviderSettings,
} from '@/providers/dsh/settings';

function createDshHost(model = 'dsh-4'): ProviderHost {
  const host = { getResolvedProviderCliPath: async () => 'dsh', settings: { model: `dsh:${model}`, providerConfigs: { dsh: { enabled: true, visibleModels: [model, "dsh-3"] } } } } as unknown as ProviderHost;
  updateCurrentDshCatalog(host.settings, { defaultModelId: model, fingerprint: 'fixture', refreshedAt: 1, models: [{ rawId: "dsh-3", displayName: "Dsh 3", supportsReasoning: false, reasoningEfforts: [] }, { rawId: model, displayName: model, supportsReasoning: true, reasoningEfforts: [] }] });
  return host;
}

const interactionPort: ProviderInteractionPort = {
  askUserQuestion: jest.fn(),
  dismissInteraction: jest.fn(),
  requestApproval: jest.fn(),
};

const sessionConfig: ProviderSessionConfig = {
  interactionPort,
  lifecycle: 'persistent',
  nativePersistence: 'enabled',
  resumeSeed: {
    providerSessionId: 'session-existing',
    providerState: { nativeConversationContextEstablished: true },
  },
  vaultWorkingDirectory: '/tmp/vault',
};

function executionRequest(text = 'hello'): ProviderExecutionRequest {
  return {
    configuration: {
      permissionMode: 'normal',
      model: 'dsh:dsh-4',
      systemInstructions: { kind: 'explicit', instructions: 'Be exact.' },
    },
    input: [{ text, type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
}

function dsh45Request(reasoning: string): ProviderExecutionRequest {
  const request = executionRequest();
  return {
    ...request,
    configuration: {
      ...request.configuration,
      model: 'dsh:dsh-4.5',
      reasoning,
    },
  };
}


function persistDsh45Catalog(
  host: ProviderHost,
  models: DshDiscoveredModel[] = [{
    displayName: 'Dsh 4.5',
    rawId: 'dsh-4.5',
    reasoningMetadataResolved: true,
    reasoningEfforts: [
      { label: 'High', value: 'high' },
      { label: 'Medium', value: 'medium' },
      { label: 'Low', value: 'low' },
    ],
    supportsReasoning: true,
  }],
): void {
  updateCurrentDshCatalog(host.settings, {
    defaultModelId: 'dsh-4.5',
    fingerprint: 'catalog-fixture',
    models,
    refreshedAt: 1,
  });
}

function modelConfigOptions(
  models: Array<{ name: string; value: string }>,
  currentValue: string,
): ACPSessionConfigOption[] {
  return [{
    category: 'model',
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue,
    options: models,
  }];
}

function featurePermissionRequest(permissionMode: string): ProviderExecutionRequest {
  const base = executionRequest(permissionMode);
  return {
    ...base,
    configuration: {
      model: base.configuration.model,
      permissionMode,
      systemInstructions: base.configuration.systemInstructions,
    },
  };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function pendingPrompt(): Promise<DshPromptResponse> {
  return new Promise<DshPromptResponse>(() => {});
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

type DshSetModelRequest = Parameters<DshExecutionNativeConnection['setModel']>[0];
type DshSetModelResponse = { configOptions?: ACPSessionConfigOption[] | null };
type DshPromptResponse = ACPPromptResponse;

class FakeNativeConnection implements DshExecutionNativeConnection {
  readonly loadRequests: ACPLoadSessionRequest[] = [];
  readonly modelRequests: DshSetModelRequest[] = [];
  readonly newRequests: ACPNewSessionRequest[] = [];
  readonly promptRequests: ACPPromptRequest[] = [];
  cancelCalls = 0;
  initializeCalls = 0;
  shutdownCalls = 0;
  loadResponse: ACPLoadSessionResponse | null = null;
  loadImplementation: (
    request: ACPLoadSessionRequest,
  ) => Promise<ACPLoadSessionResponse> = async request => (
    this.loadResponse ?? { sessionId: request.sessionId }
  );
  private notification: ((value: ACPSessionNotification) => void) | null = null;
  private retainedNotification: ((value: ACPSessionNotification) => void) | null = null;
  initializeImplementation: () => Promise<void> = async () => {};
  modelImplementation: (
    request: DshSetModelRequest,
  ) => Promise<DshSetModelResponse> = async () => ({});
  promptImplementation: () => Promise<DshPromptResponse> = async () => ({
    stopReason: 'end_turn',
  });
  shutdownImplementation: () => Promise<void> = async () => {};

  cancel(): void {
    this.cancelCalls += 1;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    await this.initializeImplementation();
  }

  isAlive(): boolean {
    return true;
  }

  async listCommands(): Promise<[]> {
    return [];
  }

  async loadSession(
    request: ACPLoadSessionRequest,
  ): Promise<ACPLoadSessionResponse> {
    this.loadRequests.push(request);
    return this.loadImplementation(request);
  }

  async newSession(request: ACPNewSessionRequest): Promise<{ sessionId: string }> {
    this.newRequests.push(request);
    return { sessionId: 'session-new' };
  }

  onNotification(
    listener: (value: ACPSessionNotification) => void,
  ): () => void {
    this.notification = listener;
    this.retainedNotification = listener;
    return () => { this.notification = null; };
  }

  async prompt(request: ACPPromptRequest): Promise<DshPromptResponse> {
    this.promptRequests.push(request);
    return this.promptImplementation();
  }

  async setModel(request: DshSetModelRequest): Promise<DshSetModelResponse> {
    this.modelRequests.push(request);
    return this.modelImplementation(request);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
    await this.shutdownImplementation();
  }

  emit(
    update: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): void {
    this.notification?.({
      sessionId: 'session-existing',
      update,
      ...(metadata ? { _meta: metadata } : {}),
    } as unknown as ACPSessionNotification);
  }

  emitRetained(update: Record<string, unknown>): void {
    this.retainedNotification?.({
      sessionId: 'session-existing',
      update,
    } as unknown as ACPSessionNotification);
  }
}

describe('DshExecutionBackend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an unavailable selected model before native startup with a configuration error', async () => {
    const host = createDshHost();
    host.settings.providerConfigs!.dsh!.visibleModels = [];
    const nativeFactory = { create: jest.fn() };
    const session = new DshExecutionBackend(host, { nativeFactory }).createSession(sessionConfig);
    const events = await collect(session.execute(executionRequest()).events);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error', category: 'configuration' }));
    expect(events.some(event => event.type === 'turn_started' && event.accepted)).toBe(false);
    expect(nativeFactory.create).not.toHaveBeenCalled();
    await session.dispose();
  });

  it.each(['', 'Inspect these images'])('drops image input and sends text-only prompt blocks with text %j', async text => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute({
        ...executionRequest(text),
        input: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          {
            type: 'image',
            image: { id: 'image-1', name: 'first.png', mediaType: 'image/png', data: 'aGVsbG8=', size: 5, source: 'paste' },
          },
          {
            type: 'image',
            image: { id: 'image-2', name: 'second.webp', mediaType: 'image/webp', data: 'd29ybGQ=', size: 5, source: 'drop' },
          },
        ],
      }).events);
      expect(events.at(-1)?.type).toBe('turn_completed');
      expect(native.promptRequests).toEqual([expect.objectContaining({
        prompt: text ? [{ type: 'text', text }] : [],
      })]);
    } finally {
      await session.dispose();
    }
  });

  it.each([
    ['/compact', '/compact'],
    [' \t/CoMpAcT keep recent edits\nFocus on tests  ', '/compact keep recent edits\nFocus on tests'],
  ])('compacts with only explicit instructions from %j', async (text, command) => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute({
        ...executionRequest(text),
        input: [{ type: 'text', text }, { type: 'image', image: {
          id: 'capture', name: 'capture.png', data: 'aW1hZ2U=',
          mediaType: 'image/png', size: 5, source: 'paste',
        } }],
        context: { ...capturedSelections, linkedContent: { path: 'note.md' },
          sessionReferences: [{ id: 'ref', title: 'Review', providerId: 'dsh', updatedAt: 'updated', snapshotPath: '/tmp/ref.md' }],
        },
      }).events);
      expect(native.promptRequests).toEqual([{ sessionId: 'session-existing', prompt: [{ type: 'text', text: command }] }]);
      expect(events.at(-1)?.type).toBe('turn_completed');
    } finally { await session.dispose(); }
  });

  it('rejects compact without consuming history that still needs recovery', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: () => native },
    }).createSession({ ...sessionConfig, resumeSeed: undefined });
    const conversationHistory = [{ id: 'prior', role: 'user' as const, content: 'Remember prior context', timestamp: testDate().getTime() }];
    try {
      const events = await collect(session.execute({ ...executionRequest('/compact'), conversationHistory }).events);
      expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining('normal message') });
      expect(native.promptRequests).toEqual([]);
      await collect(session.execute({ ...executionRequest('Continue'), conversationHistory }).events);
      expect(native.promptRequests[0].prompt).toEqual([{ type: 'text', text: expect.stringContaining('Remember prior context') }]);
    } finally { await session.dispose(); }
  });

  it.each(['auto_compact_completed', 'auto_compact_failed', 'auto_compact_cancelled'])(
    'maps native %s to a success divider only when completed', async sessionUpdate => {
      const native = new FakeNativeConnection();
      native.promptImplementation = async () => {
        native.emit({ sessionUpdate, tokens_before: 120000, tokens_after: 18000 });
        return { stopReason: 'end_turn' };
      };
      const session = new DshExecutionBackend(createDshHost(), {
        nativeFactory: { create: () => native },
      }).createSession(sessionConfig);
      try {
        const events = await collect(session.execute(executionRequest('/compact')).events);
        expect(events.filter(event => event.type === 'context_compacted')).toHaveLength(sessionUpdate === 'auto_compact_completed' ? 1 : 0);
        expect(events.at(-1)?.type).toBe('turn_completed');
      } finally { await session.dispose(); }
    },
  );

  it('preserves message IDs across assistant messages', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = async () => {
      for (const id of ['assistant-first', 'assistant-final']) {
        native.emit({
          content: { text: id, type: 'text' },
          messageId: id,
          sessionUpdate: 'agent_message_chunk',
        });
      }
      return { stopReason: 'end_turn' };
    };
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    try {
      const events = await collect(session.execute(executionRequest()).events);
      expect(events.filter(event => event.type === 'assistant_message_started')).toEqual([
        expect.objectContaining({ nativeAssistantId: 'assistant-first' }),
        expect.objectContaining({ nativeAssistantId: 'assistant-final' }),
      ]);
    } finally {
      await session.dispose();
    }
  });

  it.each(['notification', 'response', 'metadata'] as const)(
    'emits final usage from %s with the streamed context window',
    async source => {
      const usage = {
        inputTokens: 10327,
        outputTokens: 50,
        totalTokens: 10377,
        cachedReadTokens: 1280,
        reasoningTokens: 0,
      };
      const native = new FakeNativeConnection();
      native.promptImplementation = async () => {
        native.emit({ sessionUpdate: 'usage_update', size: 200_000, used: 12 });
        if (source === 'notification') {
          native.emit({ sessionUpdate: 'turn_completed', usage });
        }
        return {
          stopReason: 'end_turn',
          ...(source === 'response' ? { usage } : {}),
          ...(source === 'metadata' ? { _meta: { usage } } : {}),
        };
      };
      const session = new DshExecutionBackend(createDshHost(), {
        nativeFactory: { create: () => native },
      }).createSession(sessionConfig);
      try {
        const events = await collect(session.execute(executionRequest()).events);
        expect(events.filter(event => event.type === 'usage_updated').at(-1)).toMatchObject({
          usage: {
            inputTokens: 10327, cacheReadInputTokens: 1280, contextTokens: 10377,
            contextWindow: 200_000, percentage: 5,
          },
        });
      } finally {
        await session.dispose();
      }
    },
  );

  it('loads the fixed native session, configures the model, and streams correlated ACP output', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = async () => {
      native.emit({
        content: { text: 'answer', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { stopReason: 'end_turn' };
    };
    const nativeFactory: DshExecutionNativeFactory = { create: jest.fn(() => native) };
    const backend = new DshExecutionBackend(createDshHost(), { nativeFactory });
    const session = backend.createSession(sessionConfig);

    const run = session.execute(executionRequest());
    const events = await collect(run.events);

    expect(native.loadRequests).toHaveLength(1);
    expect(native.modelRequests[0]).toEqual({
      modelId: 'dsh-4',
      sessionId: 'session-existing',
    });
    expect(native.promptRequests[0]).toMatchObject({
      prompt: [{ text: 'hello', type: 'text' }],
      sessionId: 'session-existing',
    });
    expect(events.map(event => event.type)).toEqual([
      'session_state_changed',
      'session_state_changed',
      'turn_started',
      'assistant_message_started',
      'text_delta',
      'session_state_changed',
      'turn_completed',
    ]);
    expect(events.every(event => event.scope.executionId === run.executionId)).toBe(true);
    expect(events.map(event => event.scope.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.filter(event => event.type === 'session_state_changed')).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-existing',
          status: 'idle',
        }),
      }),
    ]);
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-existing',
      status: 'idle',
    });
  });

  it('encodes path-only Linked content without changing the Vault-root session CWD', async () => {
    const native = new FakeNativeConnection();
    const nativeFactory: DshExecutionNativeFactory = { create: jest.fn(() => native) };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);
    const baseRequest = executionRequest('Inspect linked content');

    await collect(session.execute({
      ...baseRequest,
      context: { ...capturedSelections, sessionReferences: [{ id: 'conv-1-ref', title: 'Review', providerId: 'codex', updatedAt: 'updated', snapshotPath: '/tmp/claudian-sessions/ref.md' }], linkedContent: { path: 'Projects/Research' } },
    }).events);

    expect(native.loadRequests[0]?.cwd).toBe('/tmp/vault');
    expect(native.promptRequests[0]?.prompt).toEqual([{
      text: 'Inspect linked content\n\n<linked_content path="Projects/Research" />\n\n' + capturedSelectionPrompt + '\n\n<context_sessions>\n<context_session title="Review" id="conv-1-ref" provider="codex" updated="updated" path="/tmp/claudian-sessions/ref.md" />\n</context_sessions>',
      type: 'text',
    }]);
    expect(JSON.stringify(native.promptRequests[0]?.prompt)).not.toMatch(
      /<(?:linked_note|current_note)\b/,
    );
  });

  it('rejects an unsupported reasoning effort after cold-session model discovery', async () => {
    const native = new FakeNativeConnection();
    native.loadResponse = {
      configOptions: modelConfigOptions([{ name: 'Dsh 4.5', value: 'dsh-4.5' }], 'dsh-4.5'),
      sessionId: 'session-existing',
    };
    const host = createDshHost('dsh-4.5');
    const mergeLiveModels = jest.fn(async (models: DshDiscoveredModel[]) => {
      persistDsh45Catalog(host, models);
      return { changed: true };
    });
    const session = new DshExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    const events = await collect(session.execute(dsh45Request('max')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error' }));
    expect(native.modelRequests).toEqual([]);
    expect(native.promptRequests).toEqual([]);
  });

  it('rejects an unadvertised reasoning effort when model metadata is unknown', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(
      createDshHost('dsh-4.5'),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(dsh45Request('max')).events);

    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error' }));
    expect(native.modelRequests).toEqual([]);
    expect(native.promptRequests).toEqual([]);
  });

  it('persists live model metadata returned by model selection', async () => {
    const native = new FakeNativeConnection();
    native.modelImplementation = async () => ({
      configOptions: modelConfigOptions(
        [{ name: 'Dsh 4.5', value: 'dsh-4.5' }, { name: 'Dsh 4.6', value: 'dsh-4.6' }],
        'dsh-4.5',
      ),
    });
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    const mergeLiveModels = jest.fn();
    const session = new DshExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    await collect(session.execute(dsh45Request('low')).events);

    expect(mergeLiveModels).toHaveBeenCalledWith([
      expect.objectContaining({ rawId: 'dsh-4.5' }),
      expect.objectContaining({ rawId: 'dsh-4.6' }),
    ], 'dsh-4.5', expect.any(String));
  });

  it('continues the turn when selected-model metadata persistence fails', async () => {
    const native = new FakeNativeConnection();
    native.modelImplementation = async () => ({
      configOptions: modelConfigOptions([{ name: 'Dsh 4.5', value: 'dsh-4.5' }], 'dsh-4.5'),
    });
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    const mergeLiveModels = jest.fn(async () => {
      throw new Error('settings persistence failed');
    });
    const session = new DshExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    const events = await collect(session.execute(dsh45Request('high')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(native.promptRequests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  });

  it('continues the turn when session-model metadata persistence fails', async () => {
    const native = new FakeNativeConnection();
    native.loadResponse = {
      configOptions: modelConfigOptions([{ name: 'Dsh 4.5', value: 'dsh-4.5' }], 'dsh-4.5'),
      sessionId: 'session-existing',
    };
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    const mergeLiveModels = jest.fn(async () => {
      throw new Error('settings persistence failed');
    });
    const session = new DshExecutionBackend(host, {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);

    const events = await collect(session.execute(dsh45Request('high')).events);

    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
    expect(native.promptRequests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
  });

  it('persists live model config updates and fences notifications from a quarantined native', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    const mergeLiveModels = jest.fn(async () => ({ changed: true }));
    const session = new DshExecutionBackend(createDshHost('dsh-4.5'), {
      modelCatalogCoordinator: { mergeLiveModels },
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    const base = executionRequest();
    const run = session.execute({
      ...base,
      configuration: { ...base.configuration, model: 'dsh:dsh-4.5' },
    });
    while (native.promptRequests.length === 0) await Promise.resolve();
    const update = {
      configOptions: modelConfigOptions([{ name: 'Dsh 4', value: 'dsh-4' }], 'dsh-4'),
      sessionUpdate: 'config_option_update',
    };

    native.emit(update);
    await drainMicrotasks();
    expect(mergeLiveModels).toHaveBeenCalledWith([
      expect.objectContaining({ rawId: 'dsh-4' }),
    ], 'dsh-4', expect.any(String));

    run.cancel();
    await collect(run.events);
    native.emitRetained(update);
    await drainMicrotasks();
    expect(mergeLiveModels).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported toolbar effort without substituting a saved preference', async () => {
    const native = new FakeNativeConnection();
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    updateDshProviderSettings(host.settings, {
      preferredReasoningByModel: { 'dsh-4.5': 'low' },
    });
    const session = new DshExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(dsh45Request('max')).events);

    expect(events).toContainEqual(expect.objectContaining({ type: 'execution_error' }));
    expect(native.modelRequests).toEqual([]);
    expect(native.promptRequests).toEqual([]);
  });

  it('omits a saved per-model preference when the request has no projected effort', async () => {
    const native = new FakeNativeConnection();
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    updateDshProviderSettings(host.settings, {
      preferredReasoningByModel: { 'dsh-4.5': 'low' },
    });
    const request = dsh45Request('high');
    const { reasoning: _reasoning, ...configuration } = request.configuration;
    const session = new DshExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute({ ...request, configuration }).events);

    expect(native.modelRequests).toEqual([{
      modelId: 'dsh-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('keeps a requested reasoning effort the selected model advertises', async () => {
    const native = new FakeNativeConnection();
    const host = createDshHost('dsh-4.5');
    persistDsh45Catalog(host);
    const session = new DshExecutionBackend(
      host,
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute(dsh45Request('low')).events);

    expect(native.modelRequests).toEqual([{
      modelId: 'dsh-4.5',
      sessionId: 'session-existing',
    }]);
  });

  it('loads once per native connection and quarantines session replay from live output', async () => {
    const native = new FakeNativeConnection();
    native.loadImplementation = async request => {
      native.emit({
        content: { text: 'historical replay', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { sessionId: request.sessionId };
    };
    native.promptImplementation = async () => {
      native.emit({
        content: { text: 'live answer', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const firstEvents = await collect(session.execute(executionRequest('first')).events);
    const secondEvents = await collect(session.execute(executionRequest('second')).events);

    expect(native.loadRequests).toHaveLength(1);
    expect(firstEvents.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'live answer' }),
    ]);
    expect(secondEvents.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'live answer' }),
    ]);
  });

  it('keeps one loaded connection for dynamic model changes', async () => {
    const native = new FakeNativeConnection();
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn(() => native),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);
    const firstRequest = executionRequest('first');
    const secondRequest: ProviderExecutionRequest = {
      ...executionRequest('second'),
      configuration: {
        ...firstRequest.configuration,
        model: 'dsh:dsh-3',
      },
    };

    await collect(session.execute(firstRequest).events);
    await collect(session.execute(secondRequest).events);

    expect(nativeFactory.create).toHaveBeenCalledTimes(1);
    expect(native.loadRequests).toHaveLength(1);
    expect(native.modelRequests.map(request => request.modelId)).toEqual([
      'dsh-4',
      'dsh-3',
    ]);
  });

  it('reconnects and loads once when load-scoped session metadata changes', async () => {
    const firstNative = new FakeNativeConnection();
    const secondNative = new FakeNativeConnection();
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(firstNative)
        .mockReturnValueOnce(secondNative),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);
    const firstRequest = executionRequest('first');
    const secondRequest: ProviderExecutionRequest = {
      ...executionRequest('second'),
      configuration: {
        ...firstRequest.configuration,
        systemInstructions: { kind: 'explicit', instructions: 'Use the replacement policy.' },
      },
    };

    await collect(session.execute(firstRequest).events);
    await collect(session.execute(secondRequest).events);

    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(firstNative.loadRequests).toHaveLength(1);
    expect(firstNative.shutdownCalls).toBe(1);
    expect(secondNative.loadRequests).toEqual([
      expect.objectContaining({
        _meta: expect.objectContaining({
          systemPromptOverride: 'Use the replacement policy.',
        }),
        sessionId: 'session-existing',
      }),
    ]);
  });

  it('sends the full Dsh prompt replacement for provider-default instructions', async () => {
    const native = new FakeNativeConnection();
    const host = {
      ...createDshHost(),
      settings: {
        ...createDshHost().settings,
        mediaFolder: 'media',
        systemPrompt: 'Keep the shared instruction.',
        userName: 'Ada',
      },
    } as unknown as ProviderHost;
    const session = new DshExecutionBackend(host, {
      nativeFactory: { create: () => native },
    }).createSession(sessionConfig);
    const base = executionRequest();
    const request: ProviderExecutionRequest = {
      ...base,
      configuration: {
        ...base.configuration,
        systemInstructions: { kind: 'provider-default' },
      },
    };

    await collect(session.execute(request).events);

    const systemPrompt = String(native.loadRequests[0]?._meta?.systemPromptOverride);
    expect(systemPrompt).toContain("inside **Ada**'s Obsidian Vault");
    expect(systemPrompt).toContain('Vault absolute path: /tmp/vault');
    expect(systemPrompt).toContain('## Runtime Context');
    expect(systemPrompt).toContain('Use `bash: date`');
    expect(systemPrompt).toContain('## Vault Media');
    expect(systemPrompt).toContain('Keep the shared instruction.');
  });

  it('bootstraps canonical history only when creating a new native session', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const request = {
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'prior question', id: 'user-prior', role: 'user' as const, timestamp: 1 },
        { content: 'prior answer', id: 'assistant-prior', role: 'assistant' as const, timestamp: 2 },
      ],
    };

    await collect(session.execute(request).events);
    await collect(session.execute(request).events);

    expect(native.newRequests).toHaveLength(1);
    expect(native.promptRequests[0]?.prompt).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('prior question'),
        type: 'text',
      }),
    ]);
    expect(JSON.stringify(native.promptRequests[0]?.prompt)).toContain('prior answer');
    expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior question');
    expect(JSON.stringify(native.promptRequests[1]?.prompt)).not.toContain('prior answer');
  });

  it('persists pending cold-history replay across execution-session recreation', async () => {
    const firstNative = new FakeNativeConnection();
    firstNative.modelImplementation = async () => {
      throw new Error('model configuration failed before prompt handoff');
    };
    const backend = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => firstNative } },
    );
    const firstSession = backend.createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const request = {
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'durable prior', id: 'user-prior', role: 'user' as const, timestamp: 1 },
      ],
    };

    await collect(firstSession.execute(request).events);
    const pendingSnapshot = firstSession.getSnapshot();

    expect(pendingSnapshot).toMatchObject({
      providerSessionId: 'session-new',
      providerState: { nativeConversationContextEstablished: false },
    });
    await firstSession.dispose();

    const secondNative = new FakeNativeConnection();
    const secondSession = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => secondNative } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: {
        providerSessionId: pendingSnapshot.providerSessionId,
        providerState: pendingSnapshot.providerState,
      },
    });

    await collect(secondSession.execute(request).events);

    expect(JSON.stringify(secondNative.promptRequests[0]?.prompt)).toContain('durable prior');
    expect(secondSession.getSnapshot()).toMatchObject({
      providerState: { nativeConversationContextEstablished: true },
    });
  });

  it('does not bootstrap canonical history when loading native context', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    await collect(session.execute({
      ...executionRequest('current'),
      conversationHistory: [
        { content: 'native-owned prior', id: 'user-prior', role: 'user', timestamp: 1 },
      ],
    }).events);

    expect(JSON.stringify(native.promptRequests[0]?.prompt)).not.toContain('native-owned prior');
  });

  it('cancels an accept-edits edit request that arrives after cancellation starts', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    let nativeOptions!: DshExecutionNativeCreateOptions;
    const requestApproval = jest.fn();
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: options => { nativeOptions = options; return native; } },
    }).createSession({
      ...sessionConfig,
      interactionPort: { ...interactionPort, requestApproval },
    });
    const run = session.execute(featurePermissionRequest('acceptEdits'));
    while (native.promptRequests.length === 0) await Promise.resolve();

    run.cancel();
    const response = await nativeOptions.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow-once' }],
      sessionId: 'session-existing',
      toolCall: { kind: 'edit', title: 'probe.txt', toolCallId: 'tool-late' },
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(requestApproval).not.toHaveBeenCalled();
    await collect(run.events);
  });

  // The approval port denies, so prompted requests resolve to reject-once.
  it.each([
    ['normal', 'edit', 1, 'reject-once'],
    ['normal', 'execute', 1, 'reject-once'],
    ['acceptEdits', 'edit', 0, 'allow-once'],
    ['acceptEdits', 'execute', 1, 'reject-once'],
  ] as const)(
    'answers a %s %s permission request after %i prompts with %s',
    async (permissionMode, kind, prompts, optionId) => {
      const native = new FakeNativeConnection();
      native.promptImplementation = () => pendingPrompt();
      let nativeOptions!: DshExecutionNativeCreateOptions;
      const requestApproval = jest.fn(async (request: { interactionId: string }) => ({
        decision: 'deny' as const,
        interactionId: request.interactionId,
      }));
      const session = new DshExecutionBackend(createDshHost(), {
        nativeFactory: { create: options => { nativeOptions = options; return native; } },
      }).createSession({
        ...sessionConfig,
        interactionPort: { ...interactionPort, requestApproval },
      });
      const run = session.execute(featurePermissionRequest(permissionMode));
      while (native.promptRequests.length === 0) await Promise.resolve();

      const response = await nativeOptions.requestPermission({
        options: [
          { kind: 'allow_always', name: 'Allow edits this session', optionId: 'allow-edits-session' },
          { kind: 'allow_once', name: 'Allow', optionId: 'allow-once' },
          { kind: 'reject_once', name: 'Reject', optionId: 'reject-once' },
        ],
        sessionId: 'session-existing',
        toolCall: { kind, title: 'probe.txt', toolCallId: 'tool-1' },
      });

      expect(requestApproval).toHaveBeenCalledTimes(prompts);
      expect(response).toEqual({ outcome: { outcome: 'selected', optionId } });
      run.cancel();
      await collect(run.events);
    },
  );

  it('runs a legacy plan permission selection as a normal turn', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(featurePermissionRequest('plan')).events);

    expect(events.at(-1)?.type).toBe('turn_completed');
    expect(native.promptRequests).toHaveLength(1);
  });

  it('emits newly established native session state before terminal completion', async () => {
    const native = new FakeNativeConnection();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });

    const events = await collect(session.execute(executionRequest()).events);
    const stateEvents = events.filter(event => event.type === 'session_state_changed');

    expect(native.newRequests).toHaveLength(1);
    expect(stateEvents).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          providerState: expect.objectContaining({
            nativeConversationContextEstablished: true,
          }),
          status: 'executing',
        }),
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          providerSessionId: 'session-new',
          status: 'idle',
        }),
      }),
    ]);
    expect(stateEvents[0]).not.toHaveProperty('snapshot.providerSessionId');
    expect(events.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        providerSessionId: 'session-new',
        status: 'idle',
      }),
      type: 'session_state_changed',
    });
    expect(events.at(-1)?.type).toBe('turn_completed');
  });

  it('cancels a pre-aborted request without starting native work', async () => {
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn(() => new FakeNativeConnection()),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession({
      ...sessionConfig,
      resumeSeed: undefined,
    });
    const abortController = new AbortController();
    abortController.abort();

    const run = session.execute({
      ...executionRequest(),
      signal: abortController.signal,
    });
    expect(nativeFactory.create).not.toHaveBeenCalled();
    const events = await collect(run.events);

    expect(nativeFactory.create).not.toHaveBeenCalled();
    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'aborted', type: 'cancelled' }),
    ]);
  });

  it('quarantines cancellation and replaces the native process before the next turn', async () => {
    const first = new FakeNativeConnection();
    const second = new FakeNativeConnection();
    first.promptImplementation = () => pendingPrompt();
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);

    const firstRun = session.execute(executionRequest('first'));
    while (first.promptRequests.length === 0) await Promise.resolve();
    firstRun.cancel();
    const firstEvents = await collect(firstRun.events);
    const secondEvents = await collect(session.execute(executionRequest('second')).events);

    expect(first.cancelCalls).toBe(1);
    expect(first.shutdownCalls).toBe(1);
    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(firstEvents.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({
          reason: 'cancelled',
          recoverable: true,
        }),
        providerSessionId: 'session-existing',
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(firstEvents.at(-1)?.type).toBe('cancelled');
    expect(secondEvents.at(-1)?.type).toBe('turn_completed');
  });

  it('cancels the run when the consumer stops iterating while it is still open', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    await run.events[Symbol.asyncIterator]().return?.();
    for (let attempt = 0; attempt < 20 && native.cancelCalls === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(native.cancelCalls).toBe(1);
  });

  it('quarantines native output as soon as cancellation begins', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    run.cancel();
    native.emit({
      content: { text: 'late during cancel delivery', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    const events = await collect(run.events);

    expect(events.some(event => event.type === 'text_delta')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      reason: 'cancelled',
      type: 'cancelled',
    });
  });

  it('emits only cancelled when quarantine shutdown rejects the pending native prompt', async () => {
    const native = new FakeNativeConnection();
    let rejectPrompt: ((reason: Error) => void) | undefined;
    native.promptImplementation = () => new Promise<DshPromptResponse>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    native.shutdownImplementation = async () => {
      native.emit({
        content: { text: 'late during quarantine', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      rejectPrompt?.(new Error('transport closed while prompting'));
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    run.cancel();
    const events = await collect(run.events);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'cancelled', type: 'cancelled' }),
    ]);
    expect(native.cancelCalls).toBe(1);
    expect(native.shutdownCalls).toBe(1);
    expect(events.some(event => event.type === 'text_delta')).toBe(false);
  });

  it('fences startup rejection caused by cancellation shutdown', async () => {
    const native = new FakeNativeConnection();
    let rejectInitialize: ((reason: Error) => void) | undefined;
    native.initializeImplementation = () => new Promise<void>((_resolve, reject) => {
      rejectInitialize = reject;
    });
    native.shutdownImplementation = async () => {
      rejectInitialize?.(new Error('transport closed while initializing'));
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    const run = session.execute(executionRequest());
    while (!rejectInitialize) await Promise.resolve();

    run.cancel();
    const events = await collect(run.events);

    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'cancelled', type: 'cancelled' }),
    ]);
    expect(native.shutdownCalls).toBe(1);
  });

  it('cleans failed initialization before retrying with a fresh native generation', async () => {
    const failedNative = new FakeNativeConnection();
    const retryNative = new FakeNativeConnection();
    const failedCleanup = createDeferred<void>();
    const retryPrompt = createDeferred<DshPromptResponse>();
    failedNative.initializeImplementation = async () => {
      throw new Error('authentication handshake failed');
    };
    failedNative.shutdownImplementation = async () => {
      await failedCleanup.promise;
      throw new Error('failed native cleanup also failed');
    };
    retryNative.promptImplementation = () => retryPrompt.promise;
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn()
        .mockReturnValueOnce(failedNative)
        .mockReturnValueOnce(retryNative),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);

    let firstRunSettled = false;
    const firstEventsPromise = collect(session.execute(executionRequest('first')).events)
      .then(events => {
        firstRunSettled = true;
        return events;
      });
    await drainMicrotasks();

    expect(failedNative.isAlive()).toBe(true);
    expect(failedNative.shutdownCalls).toBe(1);
    expect(firstRunSettled).toBe(false);

    failedCleanup.resolve();
    const firstEvents = await firstEventsPromise;
    expect(firstEvents.at(-1)).toMatchObject({
      message: 'authentication handshake failed',
      type: 'execution_error',
    });
    expect(failedNative.shutdownCalls).toBe(1);

    const retryEventsPromise = collect(session.execute(executionRequest('retry')).events);
    while (retryNative.promptRequests.length === 0) await Promise.resolve();
    failedNative.emitRetained({
      content: { text: 'stale failed native output', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    retryPrompt.resolve({ stopReason: 'end_turn' });
    const retryEvents = await retryEventsPromise;

    expect(nativeFactory.create).toHaveBeenCalledTimes(2);
    expect(failedNative.initializeCalls).toBe(1);
    expect(retryNative.initializeCalls).toBe(1);
    expect(retryEvents.some(event => (
      event.type === 'text_delta' && event.text.includes('stale failed native output')
    ))).toBe(false);

    await session.dispose();
    expect(failedNative.shutdownCalls).toBe(1);
    expect(retryNative.shutdownCalls).toBe(1);
  });

  it.each(['cancel', 'dispose'] as const)(
    'joins failed initialization cleanup when %s races teardown',
    async (teardown) => {
      const native = new FakeNativeConnection();
      const initialize = createDeferred<void>();
      const cleanup = createDeferred<void>();
      native.initializeImplementation = () => initialize.promise;
      native.shutdownImplementation = () => cleanup.promise;
      const session = new DshExecutionBackend(
        createDshHost(),
        { nativeFactory: { create: () => native } },
      ).createSession(sessionConfig);
      const run = session.execute(executionRequest());
      const eventsPromise = collect(run.events);
      while (native.initializeCalls === 0) await Promise.resolve();

      initialize.reject(new Error('initialize rejected before teardown'));
      await drainMicrotasks();
      expect(native.shutdownCalls).toBe(1);

      let teardownSettled = false;
      const teardownPromise = (teardown === 'cancel'
        ? (run.cancel(), eventsPromise.then(() => undefined))
        : session.dispose()).then(() => {
        teardownSettled = true;
      });
      await drainMicrotasks();

      expect(teardownSettled).toBe(false);
      expect(native.shutdownCalls).toBe(1);

      cleanup.resolve();
      await teardownPromise;
      const events = await eventsPromise;

      expect(native.shutdownCalls).toBe(1);
      expect(events.filter(event => (
        event.type === 'cancelled'
        || event.type === 'execution_error'
        || event.type === 'turn_completed'
      ))).toEqual([
        expect.objectContaining({
          ...(teardown === 'cancel'
            ? { reason: 'cancelled', type: 'cancelled' }
            : { reason: 'session-disposed', type: 'cancelled' }),
        }),
      ]);
      await session.dispose();
    },
  );

  it('drains disposal and fences notifications and prompt rejection after disposal begins', async () => {
    const native = new FakeNativeConnection();
    let rejectPrompt: ((reason: Error) => void) | undefined;
    native.promptImplementation = () => new Promise<DshPromptResponse>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    native.shutdownImplementation = async () => {
      rejectPrompt?.(new Error('transport closed while disposing'));
      throw new Error('process shutdown failed after transport disposal');
    };
    const sessionEvents = jest.fn();
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);
    session.onEvent(sessionEvents);
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();

    const disposing = session.dispose();
    native.emit({
      content: { text: 'late', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    });
    await expect(disposing).resolves.toBeUndefined();
    const events = await collect(run.events);

    expect(native.shutdownCalls).toBe(1);
    expect(events.some(event => event.type === 'text_delta')).toBe(false);
    expect(events.filter(event => (
      event.type === 'cancelled'
      || event.type === 'execution_error'
      || event.type === 'turn_completed'
    ))).toEqual([
      expect.objectContaining({ reason: 'session-disposed', type: 'cancelled' }),
    ]);
    expect(sessionEvents).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe('disposed');
  });

  it('publishes commands from available_commands_update notifications', async () => {
    const native = new FakeNativeConnection();
    const setCommandSnapshot = jest.fn();
    native.promptImplementation = async () => {
      native.emit({
        content: { text: 'once', type: 'text' },
        sessionUpdate: 'agent_message_chunk',
      });
      native.emit({
        availableCommands: [{
          description: 'Review changes',
          input: { hint: '[path]' },
          name: 'review',
        }, {
          _meta: { path: '/home/user/.dsh/skills/commit/SKILL.md' },
          description: 'Commit changes',
          name: 'commit',
        }],
        sessionUpdate: 'available_commands_update',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      {
        commandCatalog: { setCommandSnapshot },
        nativeFactory: { create: () => native },
      },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.filter(event => event.type === 'text_delta')).toHaveLength(1);
    expect(setCommandSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'review', kind: 'command' }),
      expect.objectContaining({ name: 'commit', kind: 'skill' }),
    ]);
    // The session must expose the same snapshot: command discovery reads it
    // before falling back to the (empty) dsh command-metadata probe.
    expect(session.getCommandSnapshot?.()).toEqual([
      expect.objectContaining({ name: 'review', kind: 'command' }),
      expect.objectContaining({ name: 'commit', kind: 'skill' }),
    ]);
  });

  it('normalizes live Dsh tool names, inputs, results, and provider payloads like replay', async () => {
    const native = new FakeNativeConnection();
    const rawInput = { target_file: 'README.md' };
    const rawOutput = { bytes: 12 };
    native.promptImplementation = async () => {
      native.emit({
        rawInput,
        sessionUpdate: 'tool_call',
        title: 'read_file',
        toolCallId: 'tool-read',
      });
      native.emit({
        rawOutput,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tool-read',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      input: {
        file_path: 'README.md',
        target_file: 'README.md',
      },
      name: 'Read',
      providerPayload: {
        rawInput,
        rawName: 'read_file',
      },
      toolCallId: 'tool-read',
      type: 'tool_started',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      toolCallId: 'tool-read',
      providerPayload: {
        rawInput,
        rawName: 'read_file',
        rawOutput,
      },
      type: 'tool_completed',
    }));
  });

  it('preserves native overwrite diffs in live Dsh tool results', async () => {
    const native = new FakeNativeConnection();
    const rawInput = { content: 'new text', file_path: 'src/write.ts' };
    const rawOutput = { type: 'WriteResult' };
    native.promptImplementation = async () => {
      native.emit({
        rawInput,
        sessionUpdate: 'tool_call',
        title: 'write',
        toolCallId: 'tool-write',
      });
      native.emit({
        content: [{
          newText: 'new text',
          oldText: 'old text',
          path: 'src/write.ts',
          type: 'diff',
        }],
        rawOutput,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        toolCallId: 'tool-write',
      });
      return { stopReason: 'end_turn' };
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events).toContainEqual(expect.objectContaining({
      toolCallId: 'tool-write',
      resultDetails: {
        diff: {
          filePath: 'src/write.ts',
          diffLines: [
            { type: 'delete', text: 'old text', oldLineNum: 1 },
            { type: 'insert', text: 'new text', newLineNum: 1 },
          ],
          stats: { added: 1, removed: 1 },
        },
      },
      providerPayload: {
        rawInput,
        rawName: 'write',
        rawOutput,
      },
      type: 'tool_completed',
    }));
  });

  it('cancels an approval already resolved by the UI when the native turn is cancelled', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    let nativeOptions!: DshExecutionNativeCreateOptions;
    const session = new DshExecutionBackend(createDshHost(), {
      nativeFactory: { create: options => { nativeOptions = options; return native; } },
    }).createSession({
      ...sessionConfig,
      interactionPort: {
        ...interactionPort,
        requestApproval: async request => ({ interactionId: request.interactionId, decision: 'allow' }),
      },
    });
    const run = session.execute(executionRequest());
    while (native.promptRequests.length === 0) await Promise.resolve();
    const permission = nativeOptions.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      sessionId: 'session-existing', toolCall: { title: 'write', toolCallId: 'tool-1' },
    });
    run.cancel();
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await collect(run.events);
    await session.dispose();
  });

  it('publishes live model metadata and rejects passive auxiliary permissions', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    native.loadResponse = {
      configOptions: modelConfigOptions([{ name: 'Dsh 4', value: 'dsh-4' }], 'dsh-4'),
      sessionId: 'session-existing',
    };
    const mergeLiveModels = jest.fn();
    let nativeOptions: DshExecutionNativeCreateOptions | undefined;
    const request = {
      ...executionRequest(),
      toolPolicy: { kind: 'passive' as const },
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      {
        modelCatalogCoordinator: { mergeLiveModels },
        nativeFactory: {
          create: options => {
            nativeOptions = options;
            return native;
          },
        },
      },
    ).createSession(sessionConfig);
    const run = session.execute(request);
    while (native.promptRequests.length === 0) await Promise.resolve();

    await expect(nativeOptions?.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      sessionId: 'session-existing',
      toolCall: { title: 'write', toolCallId: 'tool-1' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(interactionPort.requestApproval).not.toHaveBeenCalled();
    expect(mergeLiveModels).toHaveBeenCalledWith(
      [expect.objectContaining({ rawId: 'dsh-4' })],
      'dsh-4',
      expect.any(String),
    );
    const systemPromptOverride = String(
      native.loadRequests[0]?._meta?.systemPromptOverride,
    );
    expect(systemPromptOverride).toContain('Be exact.');
    expect(systemPromptOverride).toContain('Do not use any tools');
    run.cancel();
    await collect(run.events);
  });

  it('fails read-only permission requests closed without claiming a native read-only profile', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = () => pendingPrompt();
    let nativeOptions: DshExecutionNativeCreateOptions | undefined;
    const session = new DshExecutionBackend(
      createDshHost(),
      {
        nativeFactory: {
          create: options => {
            nativeOptions = options;
            return native;
          },
        },
      },
    ).createSession(sessionConfig);
    const run = session.execute({
      ...executionRequest(),
      toolPolicy: { kind: 'read-only' },
    });
    while (native.promptRequests.length === 0) await Promise.resolve();

    await expect(nativeOptions?.requestPermission({
      options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }],
      sessionId: 'session-existing',
      toolCall: { title: 'read_file', toolCallId: 'tool-read' },
    })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(native.loadRequests[0]?._meta).toEqual(expect.objectContaining({
      systemPromptOverride: 'Be exact.',
    }));
    expect(native.loadRequests[0]?._meta).not.toHaveProperty('toolProfile');
    expect(interactionPort.requestApproval).not.toHaveBeenCalled();
    run.cancel();
    await collect(run.events);
  });

  it('fails closed before native startup when exact allow-list enforcement is unavailable', async () => {
    const nativeFactory: DshExecutionNativeFactory = {
      create: jest.fn(() => new FakeNativeConnection()),
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory },
    ).createSession(sessionConfig);
    const request: ProviderExecutionRequest = {
      ...executionRequest(),
      toolPolicy: { kind: 'allow-list', names: ['read_file'] },
    };

    const events = await collect(session.execute(request).events);

    expect(nativeFactory.create).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          status: 'executing',
        }),
        type: 'session_state_changed',
      }),
      expect.objectContaining({
        snapshot: expect.objectContaining({
          invalidation: expect.objectContaining({
            reason: 'configuration-changed',
            recoverable: false,
          }),
          status: 'invalidated',
        }),
        type: 'session_state_changed',
      }),
      expect.objectContaining({
        category: 'configuration',
        message: expect.stringContaining('allow-list'),
        recoverable: false,
        type: 'execution_error',
      }),
    ]);
    expect(session.getSnapshot()).toMatchObject({
      invalidation: {
        reason: 'configuration-changed',
        recoverable: false,
      },
      status: 'invalidated',
    });
  });

  it('emits invalidated provider state before a terminal execution failure', async () => {
    const native = new FakeNativeConnection();
    native.promptImplementation = async () => {
      throw new Error('transport closed while prompting');
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.at(-2)).toMatchObject({
      snapshot: expect.objectContaining({
        invalidation: expect.objectContaining({
          reason: 'transport-closed',
          recoverable: true,
        }),
        providerSessionId: 'session-existing',
        status: 'invalidated',
      }),
      type: 'session_state_changed',
    });
    expect(events.at(-1)).toMatchObject({
      category: 'transport',
      type: 'execution_error',
    });
  });

  it('identifies the stale native session when load reports it missing', async () => {
    const native = new FakeNativeConnection();
    native.loadImplementation = async () => {
      throw new Error('session not found');
    };
    const session = new DshExecutionBackend(
      createDshHost(),
      { nativeFactory: { create: () => native } },
    ).createSession(sessionConfig);

    const events = await collect(session.execute(executionRequest()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'session-existing',
      type: 'execution_error',
    });
  });
});
