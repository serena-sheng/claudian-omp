import { randomUUID } from 'node:crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '@/core/prompt/historyContext';
import { appendLinkedContent, appendSelectionContexts, appendSessionReferences } from '@/core/prompt/promptContext';

import {
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
} from '../../../core/execution';
import type { SlashCommand } from '../../../core/types';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import {
  type ACPContentBlock,
  ACPInteractionController,
  type ACPPromptResponse,
  ACPRequestedTurn,
  type ACPSessionConfigOption,
  type ACPSessionNotification,
  ACPToolStreamAdapter,
  type ACPUsage,
  buildACPUsageInfo,
  mapACPApprovalDecision,
} from '../../acp';
import type { DshCommandCatalog } from '../commands/DshCommandCatalog';
import { computeDshEnvironmentHash } from '../env/DshSettingsReconciler';
import {
  decodeDshModelId,
  findDshModel,
  getDshAvailableReasoningEfforts,
  type DshDiscoveredModel,
  normalizeDshDiscoveredModels,
} from '../models';
import { normalizeDshCommands } from '../normalization/dshCommandNormalization';
import {
  buildDshToolProviderPayload,
  normalizeDshToolInput,
  normalizeDshToolName,
  normalizeDshToolResultDetails,
  normalizeDshToolUpdate,
  resolveDshRawToolName,
} from '../normalization/dshToolNormalization';
import { parseDshPromptUsage, parseDshUsage } from '../normalization/dshUsage';
import { shouldAutoApproveDshPermission } from '../permissionModes';
import {
  buildDshSystemPrompt,
  type DshSystemPromptSettings,
} from '../prompt/DshSystemPrompt';
import { waitForDshCancelDelivery } from '../runtime/DshCancelDelivery';
import { assertDshModelAvailable } from '../runtime/DshModelAvailability';
import type { DshModelCatalogCoordinator } from '../runtime/DshModelCatalogCoordinator';
import { buildDshRuntimeEnv } from '../runtime/DshRuntimeEnvironment';
import { getDshProviderSettings } from '../settings';
import { parseDshProviderState } from '../types';
import type {
  DshExecutionNativeConnection,
  DshExecutionNativeFactory,
} from './DshExecutionBackend';
import { normalizeDshSessionModelMetadata } from './DshSessionModelMetadata';

interface DshExecutionSessionOptions {
  readonly commandCatalog?: Pick<DshCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<DshModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory: DshExecutionNativeFactory;
}

interface ActiveExecution {
  readonly abortController: AbortController;
  readonly cancellationGeneration: number;
  readonly request: ProviderExecutionRequest;
  readonly run: RequestedRunChannel;
  readonly turn: ACPRequestedTurn;
  promptUsage: ACPUsage | null;
  promptResponse?: ACPPromptResponse;
  observedTurnCompletions: number;
}

interface DshNativeSession {
  readonly native: DshExecutionNativeConnection;
  readonly sessionId: string;
}

interface DshNativeOwner {
  readonly generation: number;
  initialized: boolean;
  loadedSessionConfigurationKey: string | null;
  loadedSessionId: string | null;
  readonly modelContextKey: string;
  readonly native: DshExecutionNativeConnection;
  notificationUnsubscribe: () => void;
  shutdownFlight: Promise<void> | null;
}

/**
 * Plain-ACP execution session for `dsh --profile acp`. Compared to the Grok
 * skeleton this was ported from, dsh has no fork/rewind/interjection/mode
 * extensions: a turn is new-or-resumed session, `session/set_config_option`
 * for the model, one `session/prompt`, and `session/cancel`.
 */
export class DshExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'dsh' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private cancellationGeneration = 0;
  // dsh has no command-listing endpoint; the only command source is the
  // `available_commands_update` session notification handled below.
  private commandSnapshot: SlashCommand[] | undefined;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private nativeGeneration = 0;
  private nativeOwner: DshNativeOwner | null = null;
  private nativeStartupFlight: Promise<DshExecutionNativeConnection> | null = null;
  private quarantineGeneration = 0;
  private readonly interactionController: ACPInteractionController;
  private nativeConversationContextEstablished: boolean;
  private providerSessionId: string | undefined;
  private readonly state: SessionSnapshotState;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: DshExecutionSessionOptions,
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    const providerState = parseDshProviderState(config.resumeSeed?.providerState);
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: { ...providerState },
      readProviderSessionId: () => this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.nativeConversationContextEstablished = Boolean(
      this.providerSessionId
      && providerState.nativeConversationContextEstablished !== false,
    );
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('DeepSeek Harness execution session is disposed.');
    if (this.active) throw new Error('DeepSeek Harness execution session is already executing.');
    const run = new RequestedRunChannel({
      onCancel: source => {
        void this.#cancelRun(run, source === 'abort-signal' ? 'aborted' : 'cancelled');
      },
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: ActiveExecution = {
      abortController: new AbortController(),
      cancellationGeneration: this.cancellationGeneration,
      promptUsage: null,
      observedTurnCompletions: 0,
      request,
      run,
      turn: new ACPRequestedTurn({
        acceptsSilentUpdates: true,
        onAccept: () => {
          if (this.nativeConversationContextEstablished) return;
          this.#setNativeConversationContextEstablished(true);
          this.#updateSnapshot('executing');
          this.#emitCurrentSnapshot();
        },
        run,
        toolStreamAdapter: createDshToolStreamAdapter(),
      }),
    };
    this.active = active;
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) void this.#performExecution(active);
    return run;
  }

  cancel(): void {
    const run = this.active?.run;
    if (run) void this.#cancelRun(run, 'cancelled');
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined {
    return this.commandSnapshot?.map(command => ({ ...command }));
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.quarantineGeneration += 1;
    this.disposalFlight = (async () => {
      const active = this.active;
      if (active) await this.#cancelRun(active.run, 'session-disposed');
      if (this.cancellationFlight) await this.cancellationFlight;
      await this.#shutdownNative();
      this.interactionController.dispose();
      this.state.clearListeners();
      this.#updateSnapshot('disposed');
    })();
    return this.disposalFlight;
  }

  async #performExecution(active: ActiveExecution): Promise<void> {
    if (active.request.toolPolicy.kind === 'allow-list') {
      this.#updateSnapshot('invalidated', {
        message: 'Exact DeepSeek Harness tool allow-list enforcement is unavailable.',
        reason: 'configuration-changed',
        recoverable: false,
      });
      this.#emitCurrentSnapshot();
      active.run.finish({
        category: 'configuration',
        message: 'DeepSeek Harness does not support reliable exact allow-list enforcement.',
        recoverable: false,
        type: 'execution_error',
      });
      active.turn.dispose();
      if (this.active === active) this.active = null;
      return;
    }
    let unsubscribeClose: (() => void) | undefined;
    try {
      assertDshModelAvailable(this.plugin.settings, active.request.configuration.model);
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      const { native, sessionId } = await this.#ensureSession(
        await this.#ensureNative(active),
        active.request,
        active,
      );
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(native, sessionId, active.request, active);
      if (this.#isCancellationRequested(active)) return;
      assertDshModelAvailable(this.plugin.settings, active.request.configuration.model);
      // Only requested prompts resolve native commands.
      const compact = parseCompactCommand(getInputText(active.request));
      if (compact && !this.nativeConversationContextEstablished && active.request.conversationHistory?.length) {
        throw new Error('Send a normal message to restore the native conversation before using /compact.');
      }
      active.turn.beginLiveOutput();
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = native.onClose?.(error => {
          reject(new Error('DeepSeek Harness transport closed', { cause: error }));
        });
      });
      const response = await Promise.race([closed, native.prompt({
        prompt: compact
          ? [{ type: 'text', text: `/compact${compact.instructions ? ` ${compact.instructions}` : ''}` }]
          : buildPromptBlocks(active.request, !this.nativeConversationContextEstablished),
        sessionId,
      })]);
      if (this.#isCancellationRequested(active)) return;
      active.turn.accept(response.userMessageId);
      active.promptResponse = response;
      active.promptUsage = parseDshPromptUsage(response) ?? active.promptUsage;
      this.#finishCompletedIfReady(active);
      await Promise.race([closed, active.run.terminated]);
    } catch (error) {
      if (this.#isCancellationRequested(active)) return;
      const category = classifyError(error);
      this.#updateSnapshot('invalidated', {
        message: error instanceof Error ? error.message : String(error),
        reason: category === 'provider-session-missing'
          ? 'provider-session-missing'
          : category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: true,
      });
      this.#emitCurrentSnapshot();
      active.run.finish({
        category,
        message: error instanceof Error ? error.message : String(error),
        ...(category === 'provider-session-missing' && this.providerSessionId
          ? { missingProviderSessionId: this.providerSessionId }
          : {}),
        recoverable: true,
        type: 'execution_error',
      });
      active.turn.dispose();
      this.active = null;
    } finally {
      unsubscribeClose?.();
    }
  }

  async #ensureNative(
    active?: ActiveExecution,
  ): Promise<DshExecutionNativeConnection> {
    const currentOwner = this.nativeOwner;
    if (
      !this.nativeStartupFlight
      && currentOwner?.initialized
      && currentOwner.native.isAlive?.() !== false
    ) return currentOwner.native;
    let startupFlight = this.nativeStartupFlight;
    if (!startupFlight) {
      startupFlight = this.#startNative(this.quarantineGeneration);
      this.nativeStartupFlight = startupFlight;
      startupFlight.then(
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
        () => {
          if (this.nativeStartupFlight === startupFlight) this.nativeStartupFlight = null;
        },
      );
    }
    const native = await startupFlight;
    this.#throwIfCancellationRequested(active);
    return native;
  }

  async #startNative(
    quarantineGeneration: number,
  ): Promise<DshExecutionNativeConnection> {
    const previousOwner = this.nativeOwner;
    if (previousOwner) await this.#shutdownNativeOwner(previousOwner);
    const command = await this.plugin.getResolvedProviderCliPath('dsh') ?? 'dsh';
    if (quarantineGeneration !== this.quarantineGeneration || this.disposed) {
      throw new Error('DeepSeek Harness native startup was cancelled.');
    }
    const generation = ++this.nativeGeneration;
    const native = this.options.nativeFactory.create({
      command,
      cwd: this.config.vaultWorkingDirectory,
      env: buildDshRuntimeEnv(this.plugin.settings, command),
      requestPermission: (request, signal) => {
        const policy = this.active?.request.toolPolicy.kind;
        if (policy === 'passive' || policy === 'read-only') {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        const active = this.active;
        if (active && shouldAutoApproveDshPermission(
          active.request.configuration.permissionMode,
          request.toolCall.kind,
        )) {
          return Promise.resolve(
            signal?.aborted || this.#isCancellationRequested(active)
              ? { outcome: { outcome: 'cancelled' } }
              : mapACPApprovalDecision('allow', request.options),
          );
        }
        return this.interactionController.requestPermission(
          request,
          signal ?? this.active?.abortController.signal,
        );
      },
      version: this.plugin.manifest?.version ?? '0.0.0',
    });
    const owner: DshNativeOwner = {
      generation,
      initialized: false,
      loadedSessionConfigurationKey: null,
      loadedSessionId: null,
      modelContextKey: computeDshEnvironmentHash(this.plugin.settings),
      native,
      notificationUnsubscribe: () => {},
      shutdownFlight: null,
    };
    this.nativeOwner = owner;
    try {
      owner.notificationUnsubscribe = native.onNotification((notification) => {
        if (this.#isCurrentNativeOwner(owner)) this.handleNotification(notification);
      });
      await native.initialize();
      if (
        quarantineGeneration !== this.quarantineGeneration
        || this.disposed
        || !this.#isCurrentNativeOwner(owner)
      ) {
        throw new Error('DeepSeek Harness native startup was cancelled.');
      }
      owner.initialized = true;
      return native;
    } catch (error) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch {
        // Startup cleanup cannot replace the error that initiated quarantine.
      }
      throw error;
    }
  }

  async #ensureSession(
    native: DshExecutionNativeConnection,
    request: ProviderExecutionRequest | undefined,
    active?: ActiveExecution,
  ): Promise<DshNativeSession> {
    const owner = this.#getNativeOwner(native);
    const sessionConfigurationKey = request
      ? this.#buildSessionConfigurationKey(request)
      : null;
    if (this.providerSessionId) {
      if (owner.loadedSessionId === this.providerSessionId) {
        if (
          request
          && owner.loadedSessionConfigurationKey !== sessionConfigurationKey
        ) {
          await this.#shutdownNative();
          this.#throwIfCancellationRequested(active);
          const replacement = await this.#ensureNative(active);
          return this.#ensureSession(replacement, request, active);
        }
        return { native, sessionId: this.providerSessionId };
      }
      const targetSessionId = this.providerSessionId;
      return {
        native,
        sessionId: await this.#loadProviderSession(
          native,
          targetSessionId,
          request,
          active,
          sessionConfigurationKey,
        ),
      };
    }
    const response = await native.newSession({
      _meta: this.#buildSessionMeta(request),
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
    });
    this.#throwIfCancellationRequested(active);
    this.#captureProviderSession(response.sessionId);
    this.#setNativeConversationContextEstablished(false);
    owner.loadedSessionId = response.sessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return { native, sessionId: response.sessionId };
  }

  async #loadProviderSession(
    native: DshExecutionNativeConnection,
    targetSessionId: string,
    request: ProviderExecutionRequest | undefined,
    active: ActiveExecution | undefined,
    sessionConfigurationKey: string | null,
  ): Promise<string> {
    const owner = this.#getNativeOwner(native);
    // The connection maps this logical call to dsh's `session/resume`.
    const response = await native.loadSession({
      _meta: this.#buildSessionMeta(request),
      cwd: this.config.vaultWorkingDirectory,
      mcpServers: [],
      sessionId: targetSessionId,
    });
    this.#throwIfCancellationRequested(active);
    const loadedSessionId = response.sessionId ?? targetSessionId;
    this.#captureProviderSession(loadedSessionId);
    owner.loadedSessionId = loadedSessionId;
    owner.loadedSessionConfigurationKey = sessionConfigurationKey;
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    await this.#publishSessionModels(response, owner.modelContextKey);
    this.#throwIfCancellationRequested(active);
    return loadedSessionId;
  }

  #buildSessionMeta(
    request: ProviderExecutionRequest | undefined,
  ): Record<string, unknown> {
    if (!request) return {};
    const systemPromptOverride = buildDshSystemPromptOverride(
      request,
      request.configuration.systemInstructions.kind === 'provider-default'
        ? buildDshSystemPrompt(this.#getSystemPromptSettings())
        : undefined,
    );
    // Passed through as ACP `_meta`; dsh is free to ignore unknown keys.
    return systemPromptOverride ? { systemPromptOverride } : {};
  }

  #buildSessionConfigurationKey(request: ProviderExecutionRequest): string {
    const meta = this.#buildSessionMeta(request);
    return JSON.stringify({
      systemPromptOverride: meta.systemPromptOverride ?? null,
    });
  }

  #getSystemPromptSettings(): DshSystemPromptSettings {
    return {
      customPrompt: this.plugin.settings.systemPrompt,
      mediaFolder: this.plugin.settings.mediaFolder,
      userName: this.plugin.settings.userName,
      vaultPath: this.config.vaultWorkingDirectory,
    };
  }

  async #applyConfiguration(
    native: DshExecutionNativeConnection,
    sessionId: string,
    request: ProviderExecutionRequest,
    active: ActiveExecution,
  ): Promise<void> {
    const rawModel = request.configuration.model
      ? decodeDshModelId(request.configuration.model)
      : null;
    if (!rawModel) return;
    // The request can predate model discovery, so validate again after
    // ensureSession has published the live model catalog. dsh publishes no
    // reasoning efforts, so any explicit effort request is rejected here.
    this.#resolveReasoningEffort(rawModel, request.configuration.reasoning ?? undefined);
    const response = await native.setModel({ modelId: rawModel, sessionId });
    this.#throwIfCancellationRequested(active);
    if (response.configOptions) {
      await this.#publishModelsFromConfig(response.configOptions, this.#getNativeOwner(native));
      this.#throwIfCancellationRequested(active);
    }
  }

  #resolveReasoningEffort(
    rawModelId: string,
    requestedReasoning: string | undefined,
  ): void {
    const requested = requestedReasoning?.trim() ?? '';
    if (!requested) return;
    const settings = getDshProviderSettings(this.plugin.settings);
    const model = findDshModel(settings.currentCatalog?.models ?? [], rawModelId);
    const advertisedValues = getDshAvailableReasoningEfforts(model)
      .map(effort => effort.value);
    if (advertisedValues.includes(requested)) return;

    throw new Error(`DeepSeek Harness model "${rawModelId}" does not support reasoning effort "${requested}".`);
  }

  private handleNotification(notification: ACPSessionNotification): void {
    const active = this.active;
    if (
      this.disposed
      || !active
      || this.#isCancellationRequested(active)
      || notification.sessionId !== this.providerSessionId
    ) return;
    // dsh may emit update kinds outside the typed ACP union (e.g. compaction notices).
    const updateKind: string = notification.update.sessionUpdate;
    if (updateKind === 'auto_compact_completed') {
      if (active.turn.acceptingLiveOutput) {
        active.turn.accept();
        active.run.emit({ type: 'context_compacted' });
      }
      return;
    }
    if (isTurnCompleted(notification.update)) {
      if (active.turn.acceptingLiveOutput) {
        const usage: unknown = 'usage' in notification.update ? notification.update.usage : undefined;
        active.promptUsage = parseDshUsage(usage)
          ?? active.promptUsage;
        active.observedTurnCompletions += 1;
        this.#finishCompletedIfReady(active);
      }
      return;
    }
    let update = notification.update;
    // dsh does not attach grok-style _meta message ids; chunks pass through as-is.
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      update = normalizeDshToolUpdate(update);
    }
    const metadata = active.turn.handleUpdate(update);
    if (metadata?.type === 'commands' && update.sessionUpdate === 'available_commands_update') {
      const commands = normalizeDshCommands(update.availableCommands);
      this.commandSnapshot = commands;
      this.options.commandCatalog?.setCommandSnapshot(commands);
    } else if (metadata?.type === 'config_options') {
      const owner = this.nativeOwner;
      if (owner) void this.#publishModelsFromConfig(metadata.configOptions, owner);
    }
  }

  #finishCompletedIfReady(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active) || !active.promptResponse) return;
    const response = active.promptResponse;
    if (active.promptUsage) {
      const model = active.request.configuration.model ?? '';
      const advertisedWindow = findDshModel(
        getDshProviderSettings(this.plugin.settings).currentCatalog?.models ?? [], model,
      )?.contextWindow;
      const size = active.turn.contextUsage?.size || advertisedWindow;
      const usage = buildACPUsageInfo({
        model: decodeDshModelId(model) ?? undefined,
        contextWindow: size ? { size, used: active.promptUsage.totalTokens } : null,
        promptUsage: active.promptUsage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.run.finish({
      providerPayload: response,
      reason: mapStopReason(response.stopReason),
      type: 'turn_completed',
    });
    active.turn.dispose();
    this.active = null;
  }

  async #cancelRun(run: RequestedRunChannel, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.cancellationGeneration += 1;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    this.quarantineGeneration += 1;
    active.abortController.abort();
    this.interactionController.dismissAll('cancelled');
    const native = this.nativeOwner?.native ?? null;
    this.cancellationFlight = (async () => {
      const sessionId = this.providerSessionId;
      if (native && sessionId) native.cancel(sessionId);
      try {
        await waitForDshCancelDelivery(
          native?.flush ? { flush: () => native.flush!() } : undefined,
        );
        await this.#shutdownNative();
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('invalidated', {
            message: 'The cancelled DeepSeek Harness process was quarantined and will be replaced.',
            reason: 'cancelled',
            recoverable: true,
          });
          this.#emitCurrentSnapshot();
        }
        active.run.finish({
          reason,
          type: 'cancelled',
        });
        active.turn.dispose();
        if (this.active === active) this.active = null;
      }
    })().finally(() => {
      this.cancellationFlight = null;
    });
    return this.cancellationFlight;
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed
      || active.cancellationGeneration !== this.cancellationGeneration
      || this.active !== active
      || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution | undefined): void {
    if (active && this.#isCancellationRequested(active)) {
      throw new DshExecutionCancellationError();
    }
  }

  async #shutdownNative(): Promise<void> {
    const startupFlight = this.nativeStartupFlight;
    const owner = this.nativeOwner;
    let shutdownError: Error | null = null;
    if (owner) {
      try {
        await this.#shutdownNativeOwner(owner);
      } catch (error) {
        shutdownError = toError(error);
      }
    }
    if (startupFlight) {
      try {
        await startupFlight;
      } catch {
        // The startup caller receives the initiating startup failure.
      }
    }
    const remainingOwner = this.nativeOwner;
    if (remainingOwner) {
      try {
        await this.#shutdownNativeOwner(remainingOwner);
      } catch (error) {
        shutdownError ??= toError(error);
      }
    }
    if (shutdownError) throw shutdownError;
  }

  #shutdownNativeOwner(owner: DshNativeOwner): Promise<void> {
    if (this.nativeOwner === owner) {
      this.nativeOwner = null;
      // Commands are advertised per native session; drop them with that session.
      this.commandSnapshot = undefined;
      try {
        owner.notificationUnsubscribe();
      } catch {
        // Listener cleanup cannot prevent process shutdown.
      }
    }
    if (!owner.shutdownFlight) {
      owner.shutdownFlight = Promise.resolve().then(() => owner.native.shutdown());
    }
    return owner.shutdownFlight;
  }

  #isCurrentNativeOwner(owner: DshNativeOwner): boolean {
    return !this.disposed
      && owner.generation === this.nativeGeneration
      && this.nativeOwner === owner;
  }

  #getNativeOwner(
    native: DshExecutionNativeConnection,
  ): DshNativeOwner {
    const owner = this.nativeOwner;
    if (!owner || owner.native !== native) {
      throw new Error('DeepSeek Harness native connection ownership changed.');
    }
    return owner;
  }

  #captureProviderSession(providerSessionId: string): void {
    this.providerSessionId = providerSessionId;
  }

  #setNativeConversationContextEstablished(established: boolean): void {
    this.nativeConversationContextEstablished = established;
    this.state.setProviderStateValue('nativeConversationContextEstablished', established);
  }

  async #publishSessionModels(
    response: Pick<
      Awaited<ReturnType<DshExecutionNativeConnection['newSession']>>,
      'configOptions'
    >,
    sourceContextKey: string,
  ): Promise<void> {
    const { currentModelId, models } = normalizeDshSessionModelMetadata(response);
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(
        models,
        currentModelId ?? undefined,
        sourceContextKey,
      );
    }
  }

  async #publishModelsFromConfig(
    options: readonly ACPSessionConfigOption[],
    owner: DshNativeOwner,
  ): Promise<void> {
    if (!this.#isCurrentNativeOwner(owner)) return;
    const modelOption = options.find(option => option.id === 'model' && option.type === 'select');
    if (!modelOption || modelOption.type !== 'select') return;
    const flat = modelOption.options.flatMap(option => (
      'options' in option ? option.options : [option]
    ));
    const models = normalizeDshDiscoveredModels(flat.map(option => ({
      displayName: option.name,
      rawId: option.value,
      reasoningEfforts: [],
      supportsReasoning: false,
    })));
    if (models.length > 0) {
      await this.#mergeModelMetadataBestEffort(
        models,
        modelOption.currentValue,
        owner.modelContextKey,
      );
    }
  }

  async #mergeModelMetadataBestEffort(
    models: DshDiscoveredModel[],
    defaultModelId: string | undefined,
    sourceContextKey: string,
  ): Promise<void> {
    try {
      await this.options.modelCatalogCoordinator?.mergeLiveModels(
        models,
        defaultModelId,
        sourceContextKey,
      );
    } catch {
      // Catalog synchronization is best-effort and cannot disrupt execution.
    }
  }

  #updateSnapshot(
    status: ProviderSessionStatus,
    invalidation?: ProviderSessionInvalidation,
  ): void {
    if (status === 'invalidated') this.state.invalidate(invalidation!);
    else this.state.setStatus(status);
  }

  #emitCurrentSnapshot(): void {
    const active = this.active;
    const event = {
      snapshot: this.state.getSnapshot(),
      type: 'session_state_changed' as const,
    };
    if (active && !active.run.isTerminal) {
      active.run.emit(event);
      return;
    }
    this.state.emit(event);
  }
}

class DshExecutionCancellationError extends Error {
  constructor() {
    super('DeepSeek Harness execution was cancelled.');
    this.name = 'DshExecutionCancellationError';
  }
}

function createDshToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    normalizeToolInput(rawName, input, rawOutput) {
      return normalizeDshToolInput(rawName ?? 'tool', input, rawOutput);
    },
    normalizeToolName(rawName, rawInput, rawOutput) {
      return normalizeDshToolName(rawName ?? 'tool', rawInput, rawOutput);
    },
    normalizeToolResultDetails(rawName, input, rawOutput) {
      return normalizeDshToolResultDetails(rawName ?? 'tool', input, rawOutput);
    },
    buildToolProviderPayload(rawName, rawInput, rawOutput) {
      return buildDshToolProviderPayload({ rawInput, rawName: rawName ?? 'tool', rawOutput });
    },
    resolveRawToolName(currentRawName, update) {
      return resolveDshRawToolName(currentRawName, update);
    },
  });
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function buildPromptBlocks(
  request: ProviderExecutionRequest,
  replayConversationHistory = false,
): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [];
  let text = getInputText(request);
  const context = request.context;
  if (context?.linkedContent) {
    text = appendLinkedContent(text, context.linkedContent.path);
  }
  text = appendSelectionContexts(text, context);
  text = appendSessionReferences(text, context?.sessionReferences);
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory];
    text = buildPromptWithHistoryContext(
      buildContextFromHistory(history),
      text,
      text,
      history,
    );
  }
  // dsh reports promptCapabilities.image/audio/embeddedContext = false, so only
  // text blocks are sent; image input is dropped instead of failing the turn.
  if (text) blocks.push({ text, type: 'text' });
  return blocks;
}

function buildDshSystemPromptOverride(
  request: ProviderExecutionRequest,
  providerDefaultInstructions?: string,
): string | undefined {
  const instructions = request.configuration.systemInstructions.kind === 'explicit'
    ? request.configuration.systemInstructions.instructions.trim()
    : providerDefaultInstructions?.trim() ?? '';
  if (request.toolPolicy.kind !== 'passive') {
    return instructions || undefined;
  }
  return [instructions, DSH_PASSIVE_TOOL_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');
}

const DSH_PASSIVE_TOOL_INSTRUCTION = [
  'Do not use any tools for this request.',
  'Answer only from information supplied directly in the prompt.',
].join(' ');

function isTurnCompleted(update: unknown): boolean {
  return Boolean(
    update
    && typeof update === 'object'
    && (
      (update as Record<string, unknown>).sessionUpdate === 'turn_completed'
      || (update as Record<string, unknown>).type === 'turn_completed'
    ),
  );
}

function mapStopReason(reason: string): 'completed' | 'max-tokens' | 'provider-ended' {
  if (reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens';
  return reason === 'end_turn' || reason === 'completed' ? 'completed' : 'provider-ended';
}

function classifyError(
  error: unknown,
): 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'unknown' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (error instanceof ProviderModelUnavailableError) return 'configuration';
  if (message.includes('auth')) return 'authentication';
  if (message.includes('session') && (message.includes('missing') || message.includes('not found'))) {
    return 'provider-session-missing';
  }
  if (message.includes('config') || message.includes('model')) return 'configuration';
  if (message.includes('transport') || message.includes('closed')) return 'transport';
  return 'unknown';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
