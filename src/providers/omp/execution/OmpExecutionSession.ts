import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import { parseEnvironmentVariables } from '@/core/process/env';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getHistoryImages,
} from '@/core/prompt/historyContext';
import {
  appendLinkedContent,
  appendSelectionContexts,
  appendSessionReferences,
} from '@/core/prompt/promptContext';

import {
  type ConversationBranchRecoveryRequest,
  type ConversationBranchRequest,
  type ConversationBranchResult,
  type ConversationBranchState,
  type ProviderBackgroundEventScope,
  type ProviderBackgroundOutputEvent,
  type ProviderExecutionErrorCategory,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  type ProviderToolPolicy,
  RequestedRunChannel,
  type RequestedRunEvent,
  type RequestedRunTerminalEvent,
  SessionSnapshotState,
  type SteerableExecutionSession,
  type WithoutEventScope,
} from '../../../core/execution';
import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { ProviderModelUnavailableError } from '../../../core/providers/models/ProviderModelUnavailableError';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ChatMessage,
  StreamChunk,
  TurnStats,
} from '../../../core/types';
import type { OmpWorkspaceServices } from '../app/OmpWorkspaceServices';
import { OmpConversationHistoryService } from '../history/OmpConversationHistoryService';
import {
  isOmpSessionPathReference,
  resolveOmpSessionFileHint,
} from '../history/OmpHistoryPathResolver';
import {
  correlateOmpUserMessages,
  type CreatedOmpForkSessionFile,
  type createOmpForkSessionFile,
  findOmpSessionFile,
  getOmpConversationBranches,
  getOmpTurnStats,
  parseOmpSessionContent,
  parseOmpSessionEntries,
  resolveOmpActivePath,
  resolveOmpTreeCursor,
  type rollbackCreatedOmpForkSessionFile,
} from '../history/OmpHistoryStore';
import { encodeOmpRecoveryPrompt } from '../history/OmpRecoveryPromptCodec';
import {
  clampOmpThinkingLevel,
  decodeOmpModelId,
  findOmpModel,
} from '../models';
import {
  createOmpEventNormalizationState,
  getOmpTerminalErrorMessage,
  isOmpDisplayedCustomMessageStart,
  normalizeOmpRPCEvent,
  type OmpEventNormalizationState,
} from '../normalization/ompEventNormalization';
import { buildOmpUsageInfo, type OmpSessionTokenTotals,readOmpSessionTokenTotals, resolveOmpTurnTokens } from '../runtime/buildOmpUsageInfo';
import type { OmpExtensionUIRenderer } from '../runtime/OmpExtensionUIBridge';
import {
  buildOmpEnvironment,
  buildOmpLaunchSpec,
  type OmpLaunchSpec,
} from '../runtime/OmpLaunchSpecBuilder';
import { assertOmpModelAvailable } from '../runtime/OmpModelAvailability';
import { buildOmpSetModelPayload } from '../runtime/OmpRPCPayloads';
import { type OmpRPCRecord, OmpRPCResponseError } from '../runtime/OmpRPCTransport';
import { OMP_TREE_COMMAND } from '../runtime/OmpTreeBridge';
import {
  getOmpProviderSettings,
  type OmpProviderSettings,
} from '../settings';
import {
  getOmpState,
  type OmpProviderState,
  type OmpTreeCursor,
} from '../types';
import { normalizeOmpRuntimeCommands } from './OmpCommandMetadataProbe';
import {
  type OmpExecutionKernel,
  type OmpExecutionKernelFactory,
} from './OmpExecutionKernel';

interface OmpExecutionSessionOptions {
  readonly createForkSessionFile: typeof createOmpForkSessionFile;
  readonly createKernel: OmpExecutionKernelFactory;
  readonly extensionUiRenderer: OmpExtensionUIRenderer | null;
  readonly rollbackForkSessionFile: typeof rollbackCreatedOmpForkSessionFile;
}

type OmpExecutionServices = Pick<OmpWorkspaceServices, 'commandCatalog'>;

interface EncodedOmpRequest {
  readonly input:
    | { readonly kind: 'compact'; readonly instructions: string }
    | { readonly kind: 'prompt'; readonly text: string; readonly images: OmpPromptImage[] };
  readonly launchSpec: OmpLaunchSpec;
  readonly model: string;
  readonly thinkingLevel: string | null;
}

interface OmpPromptImage {
  readonly data: string;
  readonly mimeType: string;
  readonly type: 'image';
}

interface ActiveRun {
  readonly abortController: AbortController;
  readonly inputText: string;
  readonly run: RequestedRunChannel;
  accepted: boolean;
  assistantStarted: boolean;
  nativeRequestDispatched: boolean;
  nativeAssistantId?: string;
  turnStats?: TurnStats;
  nativeUserMessageId?: string;
  pendingTerminalError: Error | null;
  endedWithoutRetry: boolean;
  runStarted: boolean;
  /** Native settlement was observed; a later agent_start belongs to someone else. */
  settled: boolean;
  /** The latest assistant message ended without calling tools. */
  answered: boolean;
  /** Native timestamp of that message, which identifies its persisted entry. */
  answerTimestamp?: unknown;
  /** The turn ended at its answer while the native run continued in the background. */
  endedAtAnswer: boolean;
  nativeCheckpointId?: string;
  terminalSignal: Deferred<void>;
}

/** A native OMP run nobody requested, such as an extension's `sendMessage({ triggerTurn })`. */
interface BackgroundTurn {
  readonly turnId: string;
  readonly normalization: OmpEventNormalizationState;
  /** Resolves once completion is published. */
  readonly completed: Deferred<void>;
  sequence: number;
  assistantStarted: boolean;
  /** The latest assistant message ended without calling tools. */
  answered: boolean;
  nativeAssistantId?: string;
  pendingTerminalError: string | null;
  cancelTimer: number | null;
  cancelling: boolean;
}

type TurnTarget = ActiveRun | BackgroundTurn;

/** How the current OMP process ends a native run; null until the process reveals it. */
type OmpSettlementSignal = 'agent_settled' | 'agent_end';

const BACKGROUND_ABORT_GRACE_MS = 10_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: Error): void;
  resolve(value: T): void;
}

const OMP_NATIVE_PROVIDER_STATE_KEYS = [
  'treeCursor',
  'treeSelections',
  'sessionId',
  'sessionFile',
  'leafEntryId',
  'parentSession',
  'forkSource',
  'forkSourceSessionFile',
] as const satisfies readonly (keyof OmpProviderState)[];

export class OmpExecutionSession
implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'omp' as const;
  readonly sessionInstanceId = randomUUID();

  private activeRun: ActiveRun | null = null;
  #backgroundTurn: BackgroundTurn | null = null;
  #backgroundCounter = 0;
  /** Settled background turns still syncing native state before they publish completion. */
  readonly #settlingBackgroundTurns = new Set<BackgroundTurn>();
  /** OMP before 1.0 answers prompts without a disposition and never sends agent_settled. */
  #kernelSettlement: OmpSettlementSignal | null = null;
  #kernelModel: string | null = null;
  // A recreated session can recover its cursor, but cannot attest a prior caller's move.
  private branchMutationConfirmed = false;
  private disposalPromise: Promise<void> | null = null;
  private disposed = false;
  private forkMaterializationFlight: Promise<void> | null = null;
  private kernel: OmpExecutionKernel | null = null;
  private kernelGeneration = 0;
  private processKey: string | null = null;
  private readonly kernelSessionTargets = new Set<string>();
  private kernelResumeValidationTarget: string | null = null;
  private lifecycleError: Error | null = null;
  private normalizationState: OmpEventNormalizationState =
    createOmpEventNormalizationState();
  private nativeConversationContextEstablished: boolean;
  private providerSessionId: string | null;
  private readonly state: SessionSnapshotState;
  private resumeSeedNeedsValidation: boolean;
  private readonly runFlights = new Set<Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly host: ProviderHost,
    private readonly services: OmpExecutionServices,
    private readonly config: ProviderSessionConfig,
    private readonly options: OmpExecutionSessionOptions,
  ) {
    const rawState = isRecord(config.resumeSeed?.providerState)
      ? cloneRecord(config.resumeSeed.providerState)
      : {};
    const state = getOmpState(rawState);
    const providerSessionId = state.sessionId
      ?? config.resumeSeed?.providerSessionId
      ?? null;
    const nativePersistenceDisabled = config.lifecycle === 'ephemeral'
      || config.nativePersistence === 'disabled-if-supported';
    this.providerSessionId = nativePersistenceDisabled
      ? null
      : providerSessionId;
    const resumedNativeSession = !nativePersistenceDisabled
      && Boolean(state.sessionId || state.sessionFile || providerSessionId);
    // A resumed native session starts with non-zero counters, so its first stats
    // read is a baseline rather than this turn's usage.
    this.resumedNativeSession = resumedNativeSession;
    this.nativeConversationContextEstablished = resumedNativeSession;
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: {
        ...rawState,
        ...(!nativePersistenceDisabled && providerSessionId
          ? { sessionId: providerSessionId }
          : {}),
      },
      readProviderSessionId: () => this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.resumeSeedNeedsValidation = !nativePersistenceDisabled
      && !state.forkSource
      && Boolean(state.sessionFile || providerSessionId);
    if (nativePersistenceDisabled) {
      this.#removeNativeProviderState();
    }
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) {
      throw new Error('OMP execution session is disposed');
    }
    if (this.lifecycleError) {
      throw new Error('OMP execution session cleanup failed and requires disposal.');
    }
    if (this.activeRun) {
      throw new Error('OMP execution session already has an active run');
    }

    const active = this.#createActiveRun(request);
    this.activeRun = active;
    this.normalizationState = createOmpEventNormalizationState();
    this.state.setStatus('executing');
    this.#emitRequestedState(active);
    active.run.attachAbortSignal(request.signal);
    if (!active.run.isTerminal) {
      const runFlight = this.run(active, request);
      this.runFlights.add(runFlight);
      runFlight.then(
        () => this.runFlights.delete(runFlight),
        () => this.runFlights.delete(runFlight),
      );
    }
    return active.run;
  }

  async getConversationBranches(messages: readonly ChatMessage[] = []): Promise<ConversationBranchState> {
    // Cancellation closes its event stream before the native writer has exited.
    await this.shutdownPromise;
    const state = getOmpState(this.state.providerState);
    if (!state.sessionFile) return { branches: {}, userMessageIds: {} };
    const content = await fsp.readFile(state.sessionFile, 'utf8');
    const parsed = parseOmpSessionEntries(content);
    const cursor = state.treeCursor ? resolveOmpTreeCursor(parsed.entries, state.treeCursor) : undefined;
    const nativeMessages = parseOmpSessionContent(content, {
      includeBranches: false,
      ...(cursor ? { leafEntryId: cursor.leafId, requireLeafEntryId: true } : {}),
    });
    return {
      branches: getOmpConversationBranches(parsed.entries),
      userMessageIds: correlateOmpUserMessages(messages, nativeMessages),
    };
  }

  navigateConversationBranch(request: ConversationBranchRequest): Promise<ConversationBranchResult> {
    return this.#runBranchOperation(request);
  }

  reconcileConversationBranch(request: ConversationBranchRecoveryRequest): Promise<ConversationBranchResult> {
    return this.#runBranchOperation(request);
  }

  async #runBranchOperation(request: ConversationBranchRequest | ConversationBranchRecoveryRequest): Promise<ConversationBranchResult> {
    if (this.disposed || this.activeRun || this.#hasBackgroundWork() || this.lifecycleError || request.signal?.aborted || this.#shouldDisableNativePersistence()) {
      throw new Error('OMP conversation is unavailable for branching.');
    }
    if ('userMessageId' in request) this.branchMutationConfirmed = false;
    const executionRequest: ProviderExecutionRequest = {
      input: [], configuration: request.configuration,
      toolPolicy: { kind: 'provider-default' }, signal: request.signal ?? new AbortController().signal,
    };
    const active = this.#createActiveRun(executionRequest);
    // Control operations have no requested turn consumer.
    void active.terminalSignal.promise.catch(() => undefined);
    this.activeRun = active;
    active.run.attachAbortSignal(executionRequest.signal);
    this.state.setStatus('executing');
    const flight = this.#navigateBranch(active, executionRequest, request).catch((error: unknown): ConversationBranchResult => ({
      status: 'recovery-required', error: String(error),
    }));
    const tracked = flight.then(() => undefined);
    this.runFlights.add(tracked);
    try { return await flight; }
    finally {
      this.runFlights.delete(tracked);
      void tracked.catch(() => undefined);
      active.run.close();
      if (this.activeRun === active) this.activeRun = null;
      if (!this.disposed) this.state.setStatus(this.#hasBackgroundWork() ? 'executing' : 'idle');
    }
  }

  async #navigateBranch(
    active: ActiveRun,
    executionRequest: ProviderExecutionRequest,
    request: ConversationBranchRequest | ConversationBranchRecoveryRequest,
  ): Promise<ConversationBranchResult> {
    const encoded = await this.#encodeRequest(active, executionRequest);
    await this.#ensureKernel(encoded.launchSpec, active);
    await this.#validateKernelResume(active.abortController.signal);
    await this.#restoreTreeCursor(active.abortController.signal);
    if (!this.isActive(active) || !this.kernel) throw new Error('OMP navigation was cancelled.');
    const state = getOmpState(this.state.providerState);
    if (!state.sessionFile || !state.sessionId) throw new Error('OMP session is missing.');
    if (!('userMessageId' in request)) {
      const history = await this.#readBranchHistory(encoded.model, active.abortController.signal);
      return this.branchMutationConfirmed ? history : { ...history, status: 'cancelled' };
    }
    const parsed = parseOmpSessionEntries(await fsp.readFile(state.sessionFile, 'utf8'));
    const branches = getOmpConversationBranches(parsed.entries);
    if (!branches[request.userMessageId]) throw new Error('OMP prompt is missing.');
    const current = await this.#treeRequest({ operation: 'inspect' }, active.abortController.signal);
    const oldLeaf = current.leafId;
    const oldPath = oldLeaf === null ? [] : resolveOmpActivePath(parsed.entries, oldLeaf);
    if (!oldPath.some(entry => entry.id === request.userMessageId)) throw new Error('OMP prompt is no longer on the active branch.');
    const selections = { ...state.treeSelections };
    const oldCursor = state.treeCursor?.leafId === oldLeaf
      ? state.treeCursor : { targetId: oldLeaf!, leafId: oldLeaf, appendId: parsed.entries.at(-1)?.id };
    for (const entry of oldPath) {
      if (entry.id && entry.message?.role === 'user') selections[entry.id] = oldCursor;
    }
    let cursor: OmpTreeCursor;
    if (request.branchMessageId) {
      const target = request.branchMessageId;
      if (!branches[request.userMessageId].includes(target)) throw new Error('OMP branch is not an alternative to this prompt.');
      const descendants = new Set([target]);
      for (const entry of parsed.entries) {
        if (entry.id && entry.parentId && descendants.has(entry.parentId)) descendants.add(entry.id);
      }
      const remembered = selections[target];
      const leafId = [...parsed.entries].reverse().find(entry => entry.id && descendants.has(entry.id))?.id;
      if (!leafId) throw new Error('OMP branch is missing.');
      cursor = remembered && remembered.leafId && descendants.has(remembered.leafId)
        ? remembered : { targetId: leafId, leafId };
    } else {
      const entry = parsed.entries.find(item => item.id === request.userMessageId)!;
      cursor = { targetId: request.userMessageId, leafId: entry.parentId ?? null };
    }
    cursor = { ...cursor, appendId: parsed.entries.at(-1)?.id };
    // Keep a confirmed rollback cursor until the native reply proves the requested move.
    this.#setProviderStateValue('treeCursor', oldCursor);
    const result = await this.#treeRequest({ operation: 'restore', ...cursor }, active.abortController.signal);
    if (result.cancelled) return { status: 'cancelled' };
    if (!this.isActive(active)) throw new Error('OMP navigation was cancelled.');
    if (result.leafId !== cursor.leafId) cursor = { targetId: result.leafId!, leafId: result.leafId, appendId: result.leafId! };
    this.#setProviderStateValue('treeCursor', cursor);
    this.#setProviderStateValue('treeSelections', selections);
    this.branchMutationConfirmed = true;
    this.#setOptionalProviderStateValue('leafEntryId', cursor.leafId ?? undefined);
    this.state.bumpRevision();
    return this.#readBranchHistory(encoded.model, active.abortController.signal);
  }

  async #readBranchHistory(model: string, signal: AbortSignal): Promise<Extract<ConversationBranchResult, { status: 'committed' }>> {
    const history = await new OmpConversationHistoryService().hydrateConversationHistory({
      sessionId: this.providerSessionId, providerState: this.state.providerState, messages: [],
    }, this.config.vaultWorkingDirectory);
    // OMP computes context usage from the selected native branch, including compaction.
    const usage = await this.#fetchUsage(model, signal).catch(() => null);
    return { status: 'committed', messages: history.messages ?? [], usage };
  }

  async #treeRequest(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ cancelled: boolean; leafId: string | null }> {
    if (!this.kernel || signal?.aborted) throw new Error('OMP navigation is unavailable.');
    const state = getOmpState(this.state.providerState);
    const result = await this.kernel.request<Record<string, unknown>>('claudian_tree', {
      ...payload, sessionFile: state.sessionFile, sessionId: state.sessionId,
    }, 10_000, signal).catch(async (error: unknown) => {
      // A timed-out extension may still be awaiting a native hook. Fence it before accepting more input.
      if (!(error instanceof OmpRPCResponseError)) await this.#shutdownKernel();
      throw error;
    });
    if (result?.cancelled === true) {
      if (result.reloadRequired === true) await this.#shutdownKernel();
      return { cancelled: true, leafId: null };
    }
    if (result?.cancelled !== false || result.sessionId !== state.sessionId
      || result.sessionFile !== state.sessionFile || (result.leafId !== null && typeof result.leafId !== 'string')) {
      throw new Error('Invalid OMP branch identity or cursor.');
    }
    if (payload.operation === 'restore' && result.leafId !== payload.leafId) {
      const parsed = parseOmpSessionEntries(await fsp.readFile(state.sessionFile!, 'utf8'));
      const anchor = parsed.entries.find(entry => entry.id === result.leafId);
      if (anchor?.type !== 'custom' || anchor.raw.customType !== 'claudian-tree-anchor' || anchor.parentId !== payload.leafId) {
        throw new Error('OMP navigation did not reach the selected branch.');
      }
    }
    return { cancelled: false, leafId: result.leafId };
  }

  async #restoreTreeCursor(signal: AbortSignal): Promise<void> {
    const state = getOmpState(this.state.providerState);
    let cursor = state.treeCursor;
    if (!cursor) return;
    if (state.sessionFile) {
      const parsed = parseOmpSessionEntries(await fsp.readFile(state.sessionFile, 'utf8'));
      cursor = resolveOmpTreeCursor(parsed.entries, cursor);
    }
    const result = await this.#treeRequest({ operation: 'restore', ...cursor }, signal);
    if (result.cancelled) throw new Error('OMP branch restoration was cancelled.');
    if (result.leafId !== cursor.leafId) cursor = { targetId: result.leafId!, leafId: result.leafId, appendId: result.leafId! };
    this.#setProviderStateValue('treeCursor', cursor);
    this.#setOptionalProviderStateValue('leafEntryId', cursor.leafId ?? undefined);
    this.state.bumpRevision();
  }

  cancel(): void {
    const active = this.activeRun;
    // A turn that ended at its answer is complete; Stop targets the native run continuing it.
    if (!active || active.run.isTerminal || (active.endedAtAnswer && this.#backgroundTurn)) {
      this.#cancelBackgroundTurn();
      return;
    }
    this.state.setStatus('cancelling');
    this.#emitRequestedState(active);
    active.abortController.abort();
    active.terminalSignal.reject(new Error('OMP turn cancelled'));
    this.kernel?.send({ type: 'abort' });
    this.state.setStatus('idle');
    this.#emitRequestedState(active);
    this.#finishRequested(active, {
      reason: 'Cancelled',
      type: 'cancelled',
    });
    void this.#shutdownKernel();
  }

  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    try { assertOmpModelAvailable(this.host.settings, request.configuration.model); }
    catch (error) { if (error instanceof ProviderModelUnavailableError) return false; throw error; }
    const active = this.activeRun;
    const kernel = this.kernel;
    if (
      this.disposed
      || !active
      || !kernel
      || this.kernelResumeValidationTarget !== null
      || request.signal.aborted
    ) {
      return false;
    }
    const prompt = encodePrompt(request, false);
    const response = await kernel.request<{ disposition?: string } | undefined>('steer', {
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
      message: prompt.text,
    }, undefined, request.signal);
    // An input handler that consumes the steer delivers nothing to the model.
    if (response?.disposition === 'handled') return true;
    if (this.activeRun === active && !this.disposed && this.kernel === kernel) {
      this.#emitRequested(active, {
        content: getInputText(request),
        type: 'user_message_started',
      });
    }
    return true;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise;
    this.disposed = true;
    if (this.activeRun) this.cancel();
    this.disposalPromise = (async () => {
      let lifecycleError = this.lifecycleError;
      const runResults = await Promise.allSettled([...this.runFlights]);
      lifecycleError ??= getFirstRejectedError(runResults);
      try {
        await this.#shutdownKernel();
      } catch (error) {
        lifecycleError ??= toError(error);
      }
      await Promise.allSettled([...this.#settlingBackgroundTurns].map(background => background.completed.promise));
      this.state.setStatus('disposed');
      this.#emitSession({
        snapshot: this.getSnapshot(),
        type: 'session_state_changed',
      });
      this.state.clearListeners();
      if (lifecycleError) throw lifecycleError;
    })();
    return this.disposalPromise;
  }

  #createActiveRun(request: ProviderExecutionRequest): ActiveRun {
    const active: ActiveRun = {
      abortController: new AbortController(),
      inputText: getInputText(request),
      run: new RequestedRunChannel({
        onCancel: () => {
          if (this.activeRun === active) this.cancel();
        },
        sessionInstanceId: this.sessionInstanceId,
      }),
      accepted: false,
      assistantStarted: false,
      nativeRequestDispatched: false,
      pendingTerminalError: null,
      endedWithoutRetry: false,
      runStarted: false,
      settled: false,
      answered: false,
      endedAtAnswer: false,
      terminalSignal: createDeferred<void>(),
    };
    return active;
  }

  private async run(
    active: ActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<void> {
    try {
      assertOmpModelAvailable(this.host.settings, request.configuration.model);
      const encoded = await this.#encodeRequest(active, request);
      if (!this.isActive(active)) return;
      // A stopped background run may still be unwinding; input sent now could be queued behind the abort.
      await this.#awaitBackgroundCancellation(active);
      if (!this.isActive(active)) return;
      await this.#ensureKernel(encoded.launchSpec, active);
      if (!this.isActive(active) || !this.kernel) return;

      await this.#validateKernelResume(active.abortController.signal);
      if (!this.isActive(active) || !this.kernel) return;
      await this.#restoreTreeCursor(active.abortController.signal);
      if (!this.isActive(active) || !this.kernel) return;
      await this.#applyModelConfiguration(encoded, active.abortController.signal);
      if (!this.isActive(active)) return;
      assertOmpModelAvailable(this.host.settings, request.configuration.model);
      const previousLeafId = getOmpState(this.state.providerState).leafEntryId ?? null;
      const input = encoded.input;
      let promptHandled = false;
      if (input.kind === 'compact') {
        active.nativeRequestDispatched = true;
        await this.kernel.request(
          'compact',
          { customInstructions: input.instructions },
          undefined,
          active.abortController.signal,
        );
        this.#ensureAccepted(active);
        this.#emitRequested(active, { type: 'context_compacted' });
      } else {
        active.nativeRequestDispatched = true;
        const response = await this.kernel.request<OmpPromptAck | undefined>(
          'prompt',
          {
            ...(input.images.length > 0 ? { images: input.images } : {}),
            message: input.text,
            // An extension can start a run at any time; OMP rejects unqueued prompts while it streams.
            streamingBehavior: 'followUp',
          },
          undefined,
          active.abortController.signal,
        );
        this.#ensureAccepted(active);
        // Extension commands and input handlers can consume input without starting a run;
        // a local-only command (e.g. /compact) answers with agentInvoked: false and never streams run events.
        promptHandled = response?.disposition === 'handled' || response?.data?.agentInvoked === false;
        if (typeof response?.disposition !== 'string') {
          this.#kernelSettlement = 'agent_end';
          if (active.endedWithoutRetry) this.#settleRun(active);
        } else {
          this.#kernelSettlement = 'agent_settled';
        }
        if (!promptHandled) await active.terminalSignal.promise;
      }
      if (!this.isActive(active)) return;

      await this.#refreshState(active.abortController.signal);
      if (!this.isActive(active)) return;
      // A handled command may start its own run; its preflight events precede the state response.
      if (promptHandled && active.runStarted) {
        await active.terminalSignal.promise;
        if (!this.isActive(active)) return;
        await this.#refreshState(active.abortController.signal);
        if (!this.isActive(active)) return;
      }
      // Without a run, the turn has no checkpoint; the session cursor still follows the native leaf.
      const hasCheckpoint = !promptHandled || active.runStarted;
      if (hasCheckpoint) await this.#refreshNativeMessageIds(active, previousLeafId);
      const usage = await this.#fetchUsage(
        encoded.model,
        active.abortController.signal,
      ).catch(() => null);
      if (usage) {
        this.#emitRequested(active, {
          type: 'usage_updated',
          usage,
        });
      }
      this.state.setStatus(this.#hasBackgroundWork() ? 'executing' : 'idle');
      this.#emitRequestedState(active);
      this.#finishRequested(active, {
        nativeUserMessageId: active.nativeUserMessageId,
        nativeAssistantId: active.nativeAssistantId,
        ...(hasCheckpoint ? { nativeCheckpointId: active.nativeCheckpointId ?? getOmpState(this.state.providerState).leafEntryId } : {}),
        ...(active.turnStats ? { turnStats: active.turnStats } : {}),
        reason: 'completed',
        type: 'turn_completed',
      });
    } catch (error) {
      if (error instanceof OmpForkRollbackError) {
        this.lifecycleError ??= error;
        if (!active.run.isTerminal) {
          this.#invalidateForForkRollback(error);
          this.#emitRequestedState(active);
          this.#finishRequested(active, {
            category: 'provider',
            message: error.message,
            recoverable: false,
            type: 'execution_error',
          });
        } else if (!this.disposed) {
          if (this.#invalidateForForkRollback(error)) {
            this.#emitSession({
              snapshot: this.getSnapshot(),
              type: 'session_state_changed',
            });
          }
          this.#emitSession({
            category: 'provider',
            message: error.message,
            recoverable: false,
            type: 'session_error',
          });
        }
        throw error;
      }
      if (!active.run.isTerminal) {
        this.#finishError(active, error);
      }
    }
  }

  async #encodeRequest(
    active: ActiveRun,
    request: ProviderExecutionRequest,
  ): Promise<EncodedOmpRequest> {
    const settings = getOmpProviderSettings(this.host.settings);
    if (!settings.enabled) {
      throw new OmpConfigurationError('OMP is disabled.');
    }
    const model = resolveSelectedModel(request, settings, this.host.settings);
    const thinkingLevel = resolveThinkingLevel(
      request,
      settings,
      model,
      this.host.settings,
    );
    await this.#materializePendingFork(active);
    const envText = getRuntimeEnvironmentText(this.host.settings, 'omp');
    const env = buildOmpEnvironment(process.env, parseEnvironmentVariables(envText));
    this.#validateResumeSeed(env);
    const requestedApprovalMode =
      request.configuration.permissionMode ?? this.host.settings.permissionMode;
    const toolProfile = resolveToolProfile(request.toolPolicy);
    const launchSpec = buildOmpLaunchSpec({
      approvalMode: requestedApprovalMode === 'write' || requestedApprovalMode === 'yolo'
        ? requestedApprovalMode
        : 'always-ask',
      enableTreeBridge: !this.#shouldDisableNativePersistence(),
      command: await this.host.getResolvedProviderCliPath('omp') ?? 'omp',
      cwd: this.config.vaultWorkingDirectory,
      env,
      envText,
      noSession: this.#shouldDisableNativePersistence(),
      noTools: toolProfile.noTools,
      tools: toolProfile.tools,
      providerState: getOmpState(this.state.providerState),
      readOnlyTools: toolProfile.readOnlyTools,
      settings,
      systemPrompt: resolveSystemPrompt(
        request,
        this.host.settings,
        this.config.vaultWorkingDirectory,
      ),
    });
    const state = getOmpState(this.state.providerState);
    const hasNativeSession = Boolean(state.sessionId || state.sessionFile);
    const hasAcceptedCompatibleLiveContext = Boolean(
      this.nativeConversationContextEstablished
      && !hasNativeSession
      && this.#canReuseKernel(launchSpec),
    );
    if (this.#shouldDisableNativePersistence() && this.nativeConversationContextEstablished && !hasAcceptedCompatibleLiveContext) {
      throw new OmpConfigurationError('This non-persistent OMP session cannot be restored after its configuration or process changes. Start a new side chat.');
    }
    const replayConversationHistory = !hasNativeSession && !hasAcceptedCompatibleLiveContext;
    const compact = parseCompactCommand(getInputText(request));
    if (compact && replayConversationHistory && request.conversationHistory?.length) {
      throw new OmpConfigurationError('Send a normal message to restore the native conversation before using /compact.');
    }
    return {
      input: compact
        ? { kind: 'compact', instructions: compact.instructions }
        : { kind: 'prompt', ...encodePrompt(request, replayConversationHistory, this.#shouldDisableNativePersistence()) },
      launchSpec,
      model,
      thinkingLevel,
    };
  }

  #validateResumeSeed(environment: NodeJS.ProcessEnv): void {
    if (!this.resumeSeedNeedsValidation) return;
    this.resumeSeedNeedsValidation = false;
    const state = getOmpState(this.state.providerState);
    const currentTarget = state.sessionFile ?? state.sessionId;
    if (!currentTarget) return;

    const resolvedSessionFile = resolveOmpSessionFileHint(
      state.sessionFile,
      state.sessionId,
      this.config.vaultWorkingDirectory,
      { environment },
    );
    if (resolvedSessionFile) {
      let changed = false;
      if (resolvedSessionFile !== state.sessionFile) {
        this.#setProviderStateValue('sessionFile', resolvedSessionFile);
        changed = true;
      }
      if (isOmpSessionPathReference(state.sessionId)) {
        this.#deleteProviderStateValue('sessionId');
        if (this.providerSessionId === state.sessionId) {
          this.providerSessionId = null;
        }
        changed = true;
      }
      if (changed) this.state.bumpRevision();
      return;
    }

    const pathTarget = state.sessionFile
      ?? (isOmpSessionPathReference(state.sessionId) ? state.sessionId : null);
    if (pathTarget) {
      const fallbackSessionId = state.sessionId
        && !isOmpSessionPathReference(state.sessionId)
        ? state.sessionId
        : null;
      if (fallbackSessionId) {
        if (state.sessionFile === pathTarget) {
          this.#deleteProviderStateValue('sessionFile');
        }
        if (this.providerSessionId === pathTarget) {
          this.providerSessionId = fallbackSessionId;
        }
        this.state.bumpRevision();
        return;
      }
      this.nativeConversationContextEstablished = false;
      throw new OmpProviderSessionMissingError(pathTarget);
    }
  }

  async #ensureKernel(
    launchSpec: OmpLaunchSpec,
    active: ActiveRun,
  ): Promise<void> {
    await this.shutdownPromise;
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      return;
    }
    if (
      this.#canReuseKernel(launchSpec)
    ) {
      return;
    }
    await this.#shutdownKernel();
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      return;
    }
    const generation = ++this.kernelGeneration;
    const kernel = this.options.createKernel(
      launchSpec,
      {
        onClose: error => this.#handleKernelClose(kernel, generation, error),
        onEvent: event => this.#handleRpcEvent(kernel, generation, event),
        onExtensionChunk: chunk =>
          this.handleStreamChunk(kernel, generation, chunk),
        onExtensionRequest: () => {
          const currentActive = this.activeRun;
          if (
            !this.#isCurrentKernel(kernel, generation)
            || !currentActive
            || this.kernelResumeValidationTarget !== null
          ) return false;
          this.#ensureAccepted(currentActive);
          return true;
        },
      },
      this.config.lifecycle === 'persistent'
        ? this.options.extensionUiRenderer
        : null,
    );
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      await kernel.shutdown().catch(() => undefined);
      return;
    }
    this.kernel = kernel;
    this.#kernelSettlement = null;
    this.#kernelModel = null;
    this.processKey = launchSpec.processKey;
    this.kernelResumeValidationTarget = launchSpec.sessionTarget;
    this.#replaceKernelSessionTargets(launchSpec.sessionTarget);
    if (
      !this.isActive(active)
      || active.abortController.signal.aborted
      || !this.#isCurrentKernel(kernel, generation)
    ) {
      await this.#shutdownAcquiredKernel(kernel, generation);
      return;
    }
    try {
      kernel.start();
    } catch (error) {
      await this.#shutdownAcquiredKernel(kernel, generation);
      throw error;
    }
    if (
      !this.isActive(active)
      || active.abortController.signal.aborted
      || !this.#isCurrentKernel(kernel, generation)
    ) {
      await this.#shutdownAcquiredKernel(kernel, generation);
      return;
    }
    void this.#publishCommands(kernel, generation);
  }

  async #validateKernelResume(signal: AbortSignal): Promise<void> {
    const expectedTarget = this.kernelResumeValidationTarget;
    const kernel = this.kernel;
    if (!expectedTarget || !kernel) return;

    const response = await kernel.request<unknown>(
      'get_state',
      {},
      10_000,
      signal,
    );
    if (
      this.kernel !== kernel
      || this.kernelResumeValidationTarget !== expectedTarget
    ) return;
    const reportedIdentity = extractReportedOmpSessionIdentity(response);
    if (matchesExpectedOmpSession(
      expectedTarget,
      getOmpState(this.state.providerState),
      reportedIdentity,
    )) {
      this.kernelResumeValidationTarget = null;
      if (reportedIdentity.sessionFile) this.#setProviderStateValue('sessionFile', reportedIdentity.sessionFile);
      if (reportedIdentity.sessionId) {
        this.providerSessionId = reportedIdentity.sessionId;
        this.#setProviderStateValue('sessionId', reportedIdentity.sessionId);
      }
      this.state.bumpRevision();
      return;
    }

    const error = new OmpProviderSessionMismatchError(
      expectedTarget,
      reportedIdentity.sessionFile ?? reportedIdentity.sessionId,
    );
    await this.#shutdownKernel().catch(() => undefined);
    throw error;
  }

  async #applyModelConfiguration(
    encoded: EncodedOmpRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const modelPayload = buildOmpSetModelPayload(encoded.model);
    if (!modelPayload || !this.kernel) {
      throw new OmpConfigurationError('The selected OMP model is invalid.');
    }
    await this.kernel.request('set_model', modelPayload, undefined, signal);
    this.#kernelModel = encoded.model;
    if (encoded.thinkingLevel) {
      await this.kernel.request(
        'set_thinking_level',
        { level: encoded.thinkingLevel },
        undefined,
        signal,
      );
    }
  }

  #handleRpcEvent(
    kernel: OmpExecutionKernel,
    generation: number,
    event: OmpRPCRecord,
  ): void {
    if (!this.#isCurrentKernel(kernel, generation)) return;
    if (event.type === 'extension_ui_request') {
      // A dialog nobody can answer would block OMP, whether or not a run is requested.
      const id = getString(event.id);
      if (id) {
        kernel.send({
          cancelled: true,
          id,
          type: 'extension_ui_response',
        });
      }
      return;
    }
    if (event.type === 'agent_settled') this.#kernelSettlement = 'agent_settled';
    const target = this.#requestedOutputTarget() ?? this.#backgroundTurn;
    if (target) this.#trackAnswer(target, event);
    if (target?.answered && isOmpDisplayedCustomMessageStart(event)) {
      // OMP drains steered messages after a final answer within the same native run. Session
      // history ends the response at that answer, so the message starts an automatic response.
      this.#continueAfterAnswer(target);
    }
    const active = this.#requestedOutputTarget();
    if (active) {
      this.#handleRequestedRpcEvent(active, event);
    } else {
      this.#handleBackgroundRpcEvent(event);
    }
  }

  #trackAnswer(target: TurnTarget, event: OmpRPCRecord): void {
    if (event.type !== 'message_start' && event.type !== 'message_end') return;
    const message = getRecord(event.message);
    if (message.role === 'user' || (message.role === 'assistant' && event.type === 'message_start')) {
      target.answered = false;
    } else if (message.role === 'assistant') {
      target.answered = typeof message.stopReason === 'string' && message.stopReason !== 'toolUse';
      if ('run' in target) target.answerTimestamp = message.timestamp;
    }
  }

  #continueAfterAnswer(target: TurnTarget): void {
    if ('run' in target) {
      target.endedAtAnswer = true;
      this.#settleRun(target);
    } else {
      this.#settleBackgroundTurn(target);
    }
    this.#openBackgroundTurn();
  }

  #handleRequestedRpcEvent(active: ActiveRun, event: OmpRPCRecord): void {
    if (event.type === 'agent_start') {
      // Overflow recovery can start a new run even when agent_end.willRetry was false.
      active.pendingTerminalError = null;
      active.endedWithoutRetry = false;
      active.runStarted = true;
      this.#ensureAccepted(active);
      return;
    }
    if (event.type === 'agent_end') {
      if (event.willRetry === true) {
        active.pendingTerminalError = null;
        return;
      }
      active.endedWithoutRetry = true;
      if (this.#kernelSettlement === 'agent_end') this.#settleRun(active);
      return;
    }
    if (event.type === 'agent_settled') {
      this.#settleRun(active);
      return;
    }
    if (event.type === 'error') {
      active.terminalSignal.reject(new Error(
        getString(event.error) ?? 'OMP runtime error.',
      ));
      return;
    }

    const terminalError = getOmpTerminalErrorMessage(event);
    if (terminalError) {
      this.#ensureAccepted(active);
      active.pendingTerminalError = new Error(terminalError);
      return;
    }

    const chunks = normalizeOmpRPCEvent(event, this.normalizationState);
    for (const chunk of chunks) {
      this.#handleRequestedChunk(active, chunk);
    }
  }

  #handleBackgroundRpcEvent(event: OmpRPCRecord): void {
    const background = this.#backgroundTurn;
    if (event.type === 'agent_start') {
      if (background) {
        background.pendingTerminalError = null;
      } else if (this.kernelResumeValidationTarget === null) {
        // Output of an unproven native session cannot be attributed to this conversation.
        this.#openBackgroundTurn();
      }
      return;
    }
    if (!background) return;
    if (event.type === 'agent_end') {
      if (event.willRetry === true) {
        background.pendingTerminalError = null;
      } else if (this.#kernelSettlement !== 'agent_settled') {
        // Without proof that agent_settled follows, the final agent_end is the only end signal.
        this.#settleBackgroundTurn(background);
      }
      return;
    }
    if (event.type === 'agent_settled') {
      this.#settleBackgroundTurn(background);
      return;
    }
    if (event.type === 'error') {
      background.pendingTerminalError = getString(event.error) ?? 'OMP runtime error.';
      this.#settleBackgroundTurn(background);
      return;
    }
    const terminalError = getOmpTerminalErrorMessage(event);
    if (terminalError) {
      background.pendingTerminalError = terminalError;
      return;
    }
    const active = this.activeRun;
    if (
      event.type === 'message_start'
      && getRecord(event.message).role === 'user'
      && active
      && this.isActive(active)
      && active.nativeRequestDispatched
      && !active.settled
    ) {
      // OMP delivers queued input at a message boundary; the requested turn owns what follows.
      this.#settleBackgroundTurn(background);
      active.runStarted = true;
      this.#ensureAccepted(active);
      return;
    }
    for (const chunk of normalizeOmpRPCEvent(event, background.normalization)) {
      this.#handleBackgroundChunk(background, chunk);
    }
  }

  private handleStreamChunk(
    kernel: OmpExecutionKernel,
    generation: number,
    chunk: StreamChunk,
  ): void {
    if (!this.#isCurrentKernel(kernel, generation)) return;
    const active = this.#requestedOutputTarget();
    if (active) {
      this.#handleRequestedChunk(active, chunk);
    } else if (this.#backgroundTurn) {
      this.#handleBackgroundChunk(this.#backgroundTurn, chunk);
    }
  }

  /** The requested run owns native output until it settles, unless a background run is still streaming ahead of it. */
  #requestedOutputTarget(): ActiveRun | null {
    const active = this.activeRun;
    if (!active || active.run.isTerminal || active.settled || this.#backgroundTurn) return null;
    return active;
  }

  #handleRequestedChunk(active: ActiveRun, chunk: StreamChunk): void {
    if (chunk.type === 'done') return;
    if (chunk.type === 'error') {
      active.terminalSignal.reject(new Error(chunk.content));
      return;
    }
    this.#ensureAccepted(active);
    this.#emitChunk(active, chunk);
  }

  #handleBackgroundChunk(background: BackgroundTurn, chunk: StreamChunk): void {
    if (chunk.type === 'done') return;
    if (chunk.type === 'error') {
      background.pendingTerminalError = chunk.content;
      return;
    }
    this.#emitChunk(background, chunk);
  }

  #emitChunk(target: TurnTarget, chunk: StreamChunk): void {
    if (isAssistantChunk(chunk) && !target.assistantStarted) {
      target.assistantStarted = true;
      this.#emitTurn(target, { type: 'assistant_message_started' });
    }
    switch (chunk.type) {
      case 'user_message_start':
        this.#emitTurn(target, {
          content: chunk.content,
          nativeUserMessageId: chunk.itemId,
          type: 'user_message_started',
        });
        break;
      case 'assistant_message_start':
        target.assistantStarted = true;
        target.nativeAssistantId = chunk.itemId;
        this.#emitTurn(target, {
          nativeAssistantId: chunk.itemId,
          type: 'assistant_message_started',
        });
        break;
      case 'text':
        this.#emitTurn(target, { text: chunk.content, type: 'text_delta' });
        break;
      case 'thinking':
        this.#emitTurn(target, {
          text: chunk.content,
          type: 'thinking_delta',
        });
        break;
      case 'citations':
        this.#emitTurn(target, {
          citations: chunk.citations,
          type: 'citations',
        });
        break;
      case 'tool_use':
      case 'subagent_tool_use':
        this.#emitTurn(target, {
          input: chunk.input,
          name: chunk.name,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          type: 'tool_started',
        });
        break;
      case 'tool_output':
        this.#emitTurn(target, {
          content: chunk.content,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          ...(chunk.resultDetails ? { resultDetails: chunk.resultDetails } : {}),
          type: 'tool_output',
        });
        break;
      case 'tool_result':
      case 'subagent_tool_result':
        this.#emitTurn(target, {
          content: chunk.content,
          isError: chunk.isError,
          isBlocked: chunk.isBlocked,
          toolCallId: chunk.id,
          toolScope: { kind: 'main' },
          ...(chunk.resultDetails ? { resultDetails: chunk.resultDetails } : {}),
          type: 'tool_completed',
        });
        break;
      case 'usage':
        this.#emitTurn(target, {
          type: 'usage_updated',
          usage: chunk.usage,
        });
        break;
      case 'context_compacted':
        this.#emitTurn(target, { type: 'context_compacted' });
        break;
      case 'task_notification':
        this.#emitTurn(target, { content: chunk.content, type: 'task_notification' });
        break;
      case 'notice':
        this.#emitTurn(target, {
          level: chunk.level,
          message: chunk.content,
          type: 'notice',
        });
        break;
    }
  }

  #emitTurn(target: TurnTarget, event: WithoutEventScope<ProviderBackgroundOutputEvent>): void {
    if ('run' in target) {
      this.#emitRequested(target, event);
    } else {
      this.#emitBackground(target, event);
    }
  }

  #openBackgroundTurn(): void {
    const background: BackgroundTurn = {
      answered: false,
      assistantStarted: false,
      cancelTimer: null,
      cancelling: false,
      completed: createDeferred<void>(),
      normalization: createOmpEventNormalizationState(),
      pendingTerminalError: null,
      sequence: 0,
      turnId: `omp-background-${++this.#backgroundCounter}`,
    };
    this.#backgroundTurn = background;
    this.state.setStatus('executing');
    this.#emitBackground(background, {
      providerSessionId: this.providerSessionId ?? undefined,
      snapshotRevision: this.state.revision,
      type: 'background_turn_started',
    });
    this.#emitBackgroundState(background);
  }

  /** The native run ended; publish completion once the persisted leaf it appended is known. */
  #settleBackgroundTurn(background: BackgroundTurn): void {
    if (this.#backgroundTurn !== background) return;
    this.#backgroundTurn = null;
    this.#settlingBackgroundTurns.add(background);
    const kernel = this.kernel;
    const generation = this.kernelGeneration;
    void this.#syncSettledBackgroundTurn(background, kernel, generation);
  }

  async #syncSettledBackgroundTurn(
    background: BackgroundTurn,
    kernel: OmpExecutionKernel | null,
    generation: number,
  ): Promise<void> {
    const isCurrent = () => kernel !== null && this.#isCurrentKernel(kernel, generation);
    try {
      if (isCurrent() && !this.#shouldDisableNativePersistence()) {
        const path = await this.#syncNativeLeaf(undefined, isCurrent);
        background.nativeAssistantId = (path && findLastRoleId(path, 'assistant')) ?? background.nativeAssistantId;
      }
    } catch {
      // History reload still reads the native file; completion must not wait on a failed sync.
    }
    const model = this.#kernelModel;
    const usage = isCurrent() && model
      ? await this.#fetchUsage(model).catch(() => null)
      : null;
    if (usage && this.#settlingBackgroundTurns.has(background)) {
      this.#emitBackground(background, { type: 'usage_updated', usage });
    }
    this.#completeBackgroundTurn(background, background.cancelling ? 'provider-ended' : 'completed');
  }

  #completeBackgroundTurn(
    background: BackgroundTurn,
    reason: 'completed' | 'provider-ended',
  ): void {
    if (this.#backgroundTurn === background) {
      this.#backgroundTurn = null;
    } else if (!this.#settlingBackgroundTurns.delete(background)) {
      return;
    }
    if (background.cancelTimer) window.clearTimeout(background.cancelTimer);
    background.cancelTimer = null;
    if (background.pendingTerminalError) {
      this.#emitBackground(background, {
        level: 'warning',
        message: background.pendingTerminalError,
        type: 'notice',
      });
    }
    if (!this.disposed && this.state.status !== 'invalidated') {
      const requested = this.activeRun !== null && !this.activeRun.run.isTerminal;
      this.state.setStatus(requested || this.#hasBackgroundWork() ? 'executing' : 'idle');
    }
    this.#emitBackgroundState(background);
    this.#emitBackground(background, {
      nativeAssistantId: background.nativeAssistantId,
      providerSessionId: this.providerSessionId ?? undefined,
      reason,
      snapshotRevision: this.state.revision,
      type: 'background_turn_completed',
    });
    background.completed.resolve();
  }

  /** The process that ran the background turn is gone; nothing more will arrive for it. */
  #abandonBackgroundTurn(): void {
    const background = this.#backgroundTurn;
    if (background) this.#completeBackgroundTurn(background, 'provider-ended');
  }

  #cancelBackgroundTurn(): void {
    const background = this.#backgroundTurn;
    const kernel = this.kernel;
    if (!background || background.cancelling) return;
    if (!kernel) {
      this.#abandonBackgroundTurn();
      return;
    }
    background.cancelling = true;
    this.state.setStatus('cancelling');
    this.#emitBackgroundState(background);
    // OMP keeps the process (and extension state such as running subagents) across an abort.
    kernel.send({ type: 'abort' });
    const generation = this.kernelGeneration;
    background.cancelTimer = window.setTimeout(() => {
      background.cancelTimer = null;
      if (this.#backgroundTurn === background && this.#isCurrentKernel(kernel, generation)) {
        void this.#shutdownKernel().catch(() => undefined);
      }
    }, BACKGROUND_ABORT_GRACE_MS);
  }

  async #awaitBackgroundCancellation(active: ActiveRun): Promise<void> {
    const background = this.#backgroundTurn;
    if (!background?.cancelling) return;
    const signal = active.abortController.signal;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      void background.completed.promise.then(() => resolve());
    });
  }

  #hasBackgroundWork(): boolean {
    return this.#backgroundTurn !== null || this.#settlingBackgroundTurns.size > 0;
  }

  #handleKernelClose(
    kernel: OmpExecutionKernel,
    generation: number,
    error?: Error,
  ): void {
    if (!this.#isCurrentKernel(kernel, generation) || this.disposed) return;
    this.#abandonBackgroundTurn();
    const missingProviderSessionId = getOmpMissingSessionTarget(
      kernel.launchSpec,
      kernel.getStderrSnapshot(),
    );
    this.kernel = null;
    this.processKey = null;
    this.kernelResumeValidationTarget = null;
    this.kernelSessionTargets.clear();
    if (!this.#hasNativeSessionState() && !this.#shouldDisableNativePersistence()) {
      this.nativeConversationContextEstablished = false;
    }
    const active = this.activeRun;
    if (active && !active.run.isTerminal) {
      const runError = active.pendingTerminalError
        ?? error
        ?? new Error('OMP subprocess exited.');
      active.pendingTerminalError = null;
      active.terminalSignal.reject(runError);
      this.#finishError(
        active,
        runError,
        missingProviderSessionId
          ? 'provider-session-missing'
          : 'process-exited',
        missingProviderSessionId ?? undefined,
      );
    } else {
      this.state.invalidate({
        message: error?.message ?? 'OMP subprocess exited.',
        reason: 'process-exited',
        recoverable: true,
      });
      this.#emitSession({
        snapshot: this.getSnapshot(),
        type: 'session_state_changed',
      });
      this.#emitSession({
        category: 'process-exited',
        message: error?.message ?? 'OMP subprocess exited.',
        recoverable: true,
        type: 'session_error',
      });
    }
    const shutdown = kernel.shutdown()
      .catch(() => undefined)
      .finally(() => {
        if (this.shutdownPromise === shutdown) {
          this.shutdownPromise = null;
        }
      });
    this.shutdownPromise = shutdown;
  }

  #ensureAccepted(active: ActiveRun): void {
    if (!this.isActive(active) || !active.nativeRequestDispatched) return;
    this.nativeConversationContextEstablished = true;
    if (active.accepted) return;
    active.accepted = true;
    this.#emitRequested(active, {
      accepted: true,
      nativeUserMessageId: active.nativeUserMessageId,
      type: 'turn_started',
    });
    this.#emitRequested(active, {
      content: active.inputText,
      nativeUserMessageId: active.nativeUserMessageId,
      type: 'user_message_started',
    });
  }

  async #refreshState(signal: AbortSignal): Promise<void> {
    if (!this.kernel) throw new Error('OMP execution kernel is unavailable.');
    const response = await this.kernel.request<unknown>(
      'get_state',
      {},
      10_000,
      signal,
    );
    if (this.#shouldDisableNativePersistence()) {
      this.providerSessionId = null;
      this.#removeNativeProviderState();
      this.kernelSessionTargets.clear();
      this.state.bumpRevision();
      return;
    }
    const state = extractStateRecord(response);
    const sessionId = getString(state.sessionId)
      ?? getString(state.session_id)
      ?? getString(getRecord(state.session).id)
      ?? getOmpState(this.state.providerState).sessionId;
    const sessionFile = getString(state.sessionFile)
      ?? getString(state.session_file)
      ?? getString(state.sessionPath)
      ?? getString(state.session_path)
      ?? getString(state.path)
      ?? getOmpState(this.state.providerState).sessionFile;
    const leafEntryId = getString(state.leafEntryId)
      ?? getString(state.leaf_entry_id)
      ?? getOmpState(this.state.providerState).leafEntryId;
    const parentSession = getString(state.parentSession)
      ?? getString(state.parent_session)
      ?? getOmpState(this.state.providerState).parentSession;
    this.providerSessionId = sessionId ?? null;
    this.#setOptionalProviderStateValue('sessionId', sessionId);
    this.#setOptionalProviderStateValue('sessionFile', sessionFile);
    this.#setOptionalProviderStateValue('leafEntryId', leafEntryId);
    this.#setOptionalProviderStateValue('parentSession', parentSession);
    this.#replaceKernelSessionTargets(sessionFile, sessionId);
    this.#deleteProviderStateValue('forkSource');
    this.#deleteProviderStateValue('forkSourceSessionFile');
    this.state.bumpRevision();
  }

  async #refreshNativeMessageIds(
    active: ActiveRun,
    previousLeafId: string | null,
  ): Promise<void> {
    try {
      const path = await this.#syncNativeLeaf(active.abortController.signal, () => this.isActive(active));
      if (!path) return;
      const previousIndex = previousLeafId
        ? path.findIndex(entry => entry.id === previousLeafId)
        : -1;
      let entries = previousIndex >= 0 ? path.slice(previousIndex + 1) : path;
      if (active.endedAtAnswer) {
        // Entries after the answer belong to the background turn that continued the native run.
        const answerIndex = entries.findIndex(entry => entry.message?.role === 'assistant'
          && entry.message.timestamp === active.answerTimestamp);
        if (answerIndex >= 0) {
          entries = entries.slice(0, answerIndex + 1);
          active.nativeCheckpointId = entries[answerIndex].id;
        }
      }
      active.nativeUserMessageId = findLastRoleId(entries, 'user') ?? undefined;
      active.nativeAssistantId =
        findLastRoleId(entries, 'assistant')
        ?? getOmpState(this.state.providerState).leafEntryId;
      active.turnStats = getOmpTurnStats(entries, active.nativeAssistantId);
    } catch {
      active.nativeAssistantId = getOmpState(this.state.providerState).leafEntryId;
    }
  }

  /**
   * Follows the native branch a run appended to, so resume and reload include it.
   * Returns that branch, or null when there is no native file or the caller became stale.
   */
  async #syncNativeLeaf(
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ): Promise<ReturnType<typeof resolveOmpActivePath> | null> {
    const sessionFile = getOmpState(this.state.providerState).sessionFile;
    if (!sessionFile) return null;
    // Live completion follows the appended native branch, not the saved resume leaf.
    const treeState = getOmpState(this.state.providerState);
    const treeResult = treeState.treeCursor
      ? await this.#treeRequest({ operation: 'inspect' }, signal) : null;
    if (!isCurrent()) return null;
    if (treeResult?.cancelled) throw new Error('OMP branch inspection was cancelled.');
    if (treeResult && treeResult.leafId !== null) {
      this.#setProviderStateValue('treeCursor', { targetId: treeResult.leafId, leafId: treeResult.leafId, appendId: treeResult.leafId });
      this.#setOptionalProviderStateValue('leafEntryId', treeResult.leafId);
    }
    const content = await fsp.readFile(sessionFile, 'utf8');
    const parsed = parseOmpSessionEntries(content);
    if (!isCurrent()) return null;
    const path = treeResult?.leafId === null ? [] : resolveOmpActivePath(parsed.entries, treeResult?.leafId);
    const leafEntryId = [...path].reverse().find(entry => entry.id)?.id;
    if (leafEntryId) this.#setOptionalProviderStateValue('leafEntryId', leafEntryId);
    return path;
  }

  /** True when this session adopted an existing native session with prior counters. */
  private readonly resumedNativeSession: boolean;

  /** Session-cumulative totals from the last `get_session_stats` read; usage events carry the delta. */
  private lastSessionTokens: OmpSessionTokenTotals | null = null;

  async #fetchUsage(model: string, signal?: AbortSignal) {
    if (!this.kernel) return null;
    const settings = getOmpProviderSettings(this.host.settings);
    const contextWindow = findOmpModel(settings, model)?.contextWindow;
    const response = await this.kernel.request(
      'get_session_stats',
      {},
      10_000,
      signal,
    );
    const totals = readOmpSessionTokenTotals(response);
    const turnTokens = resolveOmpTurnTokens({
      adopted: this.resumedNativeSession,
      current: totals,
      previous: this.lastSessionTokens,
    });
    if (totals) this.lastSessionTokens = totals;
    return buildOmpUsageInfo(response, model, contextWindow, turnTokens);
  }

  async #publishCommands(
    kernel: OmpExecutionKernel,
    generation: number,
  ): Promise<void> {
    try {
      const response = await kernel.request<unknown>('get_available_commands', {}, 10_000);
      if (!this.#isCurrentKernel(kernel, generation) || this.disposed) return;
      this.services.commandCatalog.setCommandSnapshot(
        normalizeOmpRuntimeCommands(response).filter(command => command.name !== OMP_TREE_COMMAND),
      );
    } catch {
      // Command metadata is non-blocking; the provider-owned probe can retry.
    }
  }

  async #materializePendingFork(active: ActiveRun): Promise<void> {
    while (this.forkMaterializationFlight) {
      const priorFlight = this.forkMaterializationFlight;
      try {
        await priorFlight;
      } catch (error) {
        if (error instanceof OmpForkRollbackError) throw error;
      }
      if (this.forkMaterializationFlight === priorFlight) {
        this.forkMaterializationFlight = null;
      }
      if (!this.isActive(active) || active.abortController.signal.aborted) {
        throw new OmpExecutionCancelledError();
      }
    }
    const flight = this.#materializePendingForkForRun(active);
    this.forkMaterializationFlight = flight;
    try {
      await flight;
    } finally {
      if (this.forkMaterializationFlight === flight) {
        this.forkMaterializationFlight = null;
      }
    }
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      throw new OmpExecutionCancelledError();
    }
  }

  async #materializePendingForkForRun(active: ActiveRun): Promise<void> {
    if (this.#shouldDisableNativePersistence()) return;
    const state = getOmpState(this.state.providerState);
    const forkSource = state.forkSource;
    if (!forkSource) return;
    const envText = getRuntimeEnvironmentText(this.host.settings, 'omp');
    const env = parseEnvironmentVariables(envText);
    const sourceFile = state.forkSourceSessionFile
      ?? findOmpSessionFile(
        forkSource.sessionId,
        this.config.vaultWorkingDirectory,
        getString(env.PI_CODING_AGENT_SESSION_DIR),
      );
    if (!sourceFile) {
      throw new Error(`OMP fork source session not found: ${forkSource.sessionId}`);
    }
    const fork = await this.options.createForkSessionFile(
      sourceFile,
      forkSource.resumeAt,
      { targetCwd: this.config.vaultWorkingDirectory },
    );
    if (isSamePath(fork.sessionFile, sourceFile)) {
      throw new Error('OMP fork materialization returned the source session as its target.');
    }
    if (!this.isActive(active) || active.abortController.signal.aborted) {
      await this.#rollbackCreatedFork(fork);
      return;
    }
    this.#setProviderStateValue('leafEntryId', fork.leafEntryId);
    this.#setProviderStateValue('parentSession', fork.parentSession);
    this.#setProviderStateValue('sessionFile', fork.sessionFile);
    this.#setProviderStateValue('sessionId', fork.sessionId);
    this.#deleteProviderStateValue('forkSource');
    this.#deleteProviderStateValue('forkSourceSessionFile');
    this.providerSessionId = fork.sessionId;
    this.state.bumpRevision();
  }

  async #rollbackCreatedFork(
    fork: CreatedOmpForkSessionFile,
  ): Promise<void> {
    try {
      await this.options.rollbackForkSessionFile(fork);
    } catch (error) {
      throw new OmpForkRollbackError(toError(error));
    }
  }

  #invalidateForForkRollback(error: OmpForkRollbackError): boolean {
    const invalidation = this.state.invalidation;
    if (
      this.disposed
      || (
        this.state.status === 'invalidated'
        && invalidation?.message === error.message
        && invalidation.recoverable === false
      )
    ) return false;
    this.state.invalidate({
      message: error.message,
      reason: 'provider-error',
      recoverable: false,
    });
    return true;
  }

  #shouldDisableNativePersistence(): boolean {
    return this.config.lifecycle === 'ephemeral'
      || this.config.nativePersistence === 'disabled-if-supported';
  }

  #finishError(
    active: ActiveRun,
    error: unknown,
    category?: ProviderExecutionErrorCategory,
    missingProviderSessionId?: string,
  ): void {
    if (active.run.isTerminal) return;
    active.terminalSignal.reject(
      error instanceof Error ? error : new Error('OMP execution failed.'),
    );
    const confirmedMissingProviderSessionId = missingProviderSessionId
      ?? (error instanceof OmpProviderSessionMissingError
        ? error.providerSessionId
        : undefined);
    const details = classifyError(
      error,
      category ?? (confirmedMissingProviderSessionId
        ? 'provider-session-missing'
        : undefined),
      this.kernel?.getStderrSnapshot(),
    );
    if (details.category === 'configuration') {
      this.state.setStatus(this.#hasBackgroundWork() ? 'executing' : 'idle');
    } else {
      this.state.invalidate({
        message: details.message,
        reason: details.category === 'process-exited'
          ? 'process-exited'
          : details.category === 'provider-session-missing'
            ? 'provider-session-missing'
          : details.category === 'transport'
            ? 'transport-closed'
            : 'provider-error',
        recoverable: details.recoverable,
      });
    }
    this.#emitRequestedState(active);
    this.#finishRequested(active, {
      ...details,
      ...(confirmedMissingProviderSessionId
        ? { missingProviderSessionId: confirmedMissingProviderSessionId }
        : {}),
      type: 'execution_error',
    });
  }

  #finishRequested(
    active: ActiveRun,
    event: RequestedRunTerminalEvent,
  ): void {
    if (!active.run.finish(event)) return;
    if (this.activeRun === active) {
      this.activeRun = null;
      // No further events reach normalization; release run-scoped tool state such as nested call arguments.
      this.normalizationState = createOmpEventNormalizationState();
    }
  }

  #emitRequested(
    active: ActiveRun,
    event: RequestedRunEvent,
  ): void {
    active.run.emit(event);
  }

  #emitRequestedState(active: ActiveRun): void {
    this.#emitRequested(active, {
      snapshot: this.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  #emitBackground(
    background: BackgroundTurn,
    event: WithoutEventScope<ProviderSessionEvent>,
  ): void {
    const scope: ProviderBackgroundEventScope = {
      kind: 'background',
      sequence: ++background.sequence,
      sessionInstanceId: this.sessionInstanceId,
      turnId: background.turnId,
    };
    this.state.notify({ ...event, scope } as ProviderSessionEvent);
  }

  #emitBackgroundState(background: BackgroundTurn): void {
    this.#emitBackground(background, {
      snapshot: this.getSnapshot(),
      type: 'session_state_changed',
    });
  }

  #emitSession(event: WithoutEventScope<ProviderSessionEvent>): void {
    this.state.emit(event);
  }

  private isActive(active: ActiveRun): boolean {
    return !this.disposed
      && this.activeRun === active
      && !active.run.isTerminal;
  }

  #isCurrentKernel(
    kernel: OmpExecutionKernel,
    generation: number,
  ): boolean {
    return this.kernel === kernel
      && this.kernelGeneration === generation
      && !this.disposed;
  }

  #settleRun(active: ActiveRun): void {
    active.settled = true;
    this.#ensureAccepted(active);
    const pendingTerminalError = active.pendingTerminalError;
    active.pendingTerminalError = null;
    if (pendingTerminalError) {
      active.terminalSignal.reject(pendingTerminalError);
      return;
    }
    active.terminalSignal.resolve();
  }

  #canReuseKernel(launchSpec: OmpLaunchSpec): boolean {
    if (!this.kernel || this.processKey !== launchSpec.processKey) return false;
    return launchSpec.sessionTarget
      ? this.kernelSessionTargets.has(launchSpec.sessionTarget)
      : this.kernelSessionTargets.size === 0;
  }

  #replaceKernelSessionTargets(
    ...targets: Array<string | null | undefined>
  ): void {
    this.kernelSessionTargets.clear();
    for (const target of targets) {
      if (target) this.kernelSessionTargets.add(target);
    }
  }

  #shutdownKernel(): Promise<void> {
    this.#abandonBackgroundTurn();
    if (this.shutdownPromise) return this.shutdownPromise;
    const kernel = this.kernel;
    this.kernel = null;
    this.processKey = null;
    this.kernelResumeValidationTarget = null;
    this.kernelSessionTargets.clear();
    this.kernelGeneration += 1;
    if (!this.#hasNativeSessionState() && !this.#shouldDisableNativePersistence()) {
      this.nativeConversationContextEstablished = false;
    }
    if (!kernel) return Promise.resolve();
    const shutdown = kernel.shutdown().finally(() => {
      if (this.shutdownPromise === shutdown) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  #hasNativeSessionState(): boolean {
    const state = getOmpState(this.state.providerState);
    return Boolean(state.sessionId || state.sessionFile);
  }

  async #shutdownAcquiredKernel(
    kernel: OmpExecutionKernel,
    generation: number,
  ): Promise<void> {
    if (this.kernel === kernel && this.kernelGeneration === generation) {
      await this.#shutdownKernel().catch(() => undefined);
      return;
    }
    if (this.shutdownPromise) {
      await this.shutdownPromise.catch(() => undefined);
      return;
    }
    await kernel.shutdown().catch(() => undefined);
  }

  #setProviderStateValue(
    key: keyof OmpProviderState,
    value: unknown,
  ): void {
    this.state.setProviderStateValue(key, value);
  }

  #setOptionalProviderStateValue(
    key: keyof OmpProviderState,
    value: string | undefined,
  ): void {
    if (value) this.#setProviderStateValue(key, value);
  }

  /** Records a persisted deletion only for keys this session actually held. */
  #deleteProviderStateValue(key: keyof OmpProviderState): void {
    if (this.state.hasProviderStateValue(key)) this.state.deleteProviderStateValue(key);
  }

  #removeNativeProviderState(): void {
    for (const key of OMP_NATIVE_PROVIDER_STATE_KEYS) {
      this.#deleteProviderStateValue(key);
    }
  }

}

class OmpConfigurationError extends Error {}

class OmpExecutionCancelledError extends Error {}

class OmpProviderSessionMissingError extends Error {
  constructor(readonly providerSessionId: string) {
    super(`OMP session is unavailable: ${providerSessionId}`);
    this.name = 'OmpProviderSessionMissingError';
  }
}

class OmpProviderSessionMismatchError extends Error {
  constructor(expected: string, reported: string | null) {
    super(
      `OMP resumed an unexpected native session. Expected ${expected}, received ${reported ?? 'no session identity'}. The original conversation session was preserved.`,
    );
    this.name = 'OmpProviderSessionMismatchError';
  }
}

class OmpForkRollbackError extends Error {
  constructor(readonly cleanupError: Error) {
    super(cleanupError.message);
    this.name = 'OmpForkRollbackError';
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve(value?: T) {
      if (settled) return;
      settled = true;
      resolvePromise(value as T);
    },
  };
}

function resolveSelectedModel(
  request: ProviderExecutionRequest,
  settings: OmpProviderSettings,
  hostSettings: Record<string, unknown>,
): string {
  const model = request.configuration.model
    ?? getString(hostSettings.model);
  if (
    !model
    || !decodeOmpModelId(model)
    || !settings.visibleModels.includes(model)
  ) {
    throw new OmpConfigurationError(
      'No OMP model is selected. Enable a discovered model in Claudian settings.',
    );
  }
  return model;
}

function resolveThinkingLevel(
  request: ProviderExecutionRequest,
  settings: OmpProviderSettings,
  model: string,
  hostSettings: Record<string, unknown>,
): string | null {
  if (request.configuration.reasoning === null) return null;
  const requested = request.configuration.reasoning
    ?? getString(hostSettings.effortLevel)
    ?? settings.preferredThinkingByModel[model];
  const discovered = findOmpModel(settings, model);
  const resolved = discovered
    ? clampOmpThinkingLevel(requested, discovered.thinkingLevels)
    : requested ?? null;
  if (request.configuration.reasoning !== undefined && (resolved !== request.configuration.reasoning
    || (discovered && !discovered.thinkingLevels.some(level => level === request.configuration.reasoning)))) {
    throw new OmpConfigurationError(`OMP model "${model}" does not support thinking level "${request.configuration.reasoning}".`);
  }
  return resolved;
}

function resolveToolProfile(policy: ProviderToolPolicy): {
  noTools: boolean;
  readOnlyTools?: boolean;
  tools?: readonly string[];
} {
  if (policy.kind === 'passive') {
    return { noTools: true };
  }
  if (policy.kind === 'read-only') {
    return { noTools: false, readOnlyTools: true };
  }
  if (policy.kind === 'allow-list') {
    return { noTools: policy.names.length === 0, tools: policy.names };
  }
  return { noTools: false };
}

function resolveSystemPrompt(
  request: ProviderExecutionRequest,
  settings: Record<string, unknown>,
  vaultPath: string,
): string {
  if (request.configuration.systemInstructions.kind === 'explicit') {
    return request.configuration.systemInstructions.instructions;
  }
  return buildSystemPrompt({
    customPrompt: getString(settings.systemPrompt) ?? undefined,
    mediaFolder: getString(settings.mediaFolder) ?? undefined,
    userName: getString(settings.userName) ?? undefined,
    vaultPath,
  } satisfies SystemPromptSettings);
}

function encodePrompt(
  request: ProviderExecutionRequest,
  replayConversationHistory: boolean,
  preserveCapturedContext = false,
): {
  images: OmpPromptImage[];
  text: string;
} {
  const inputText = getInputText(request);
  let text = inputText;
  const context = request.context;
  if (context?.linkedContent?.path) {
    text = appendLinkedContent(text, context.linkedContent.path);
  }
  text = appendSelectionContexts(text, context);
  text = appendSessionReferences(text, context?.sessionReferences);
  // OMP splits a leading skill name at a literal space, not the context's newline separator.
  if (text !== inputText && /^\/skill:\S+$/.test(inputText)) {
    text = `${inputText} ${text.slice(inputText.length)}`;
  }
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    const historyContext = buildContextFromHistory(history, { preserveCapturedContext });
    const recoveredPrompt = buildPromptWithHistoryContext(
      historyContext,
      text,
      text,
      history,
    );
    text = encodeOmpRecoveryPrompt(
      historyContext,
      recoveredPrompt === historyContext ? null : text,
    );
  }
  const historyImages: OmpPromptImage[] = replayConversationHistory && preserveCapturedContext
    ? getHistoryImages(request.conversationHistory ?? []).map(image => ({
        data: image.data, mimeType: image.mediaType, type: 'image',
      })) : [];
  return {
    images: [...historyImages, ...request.input.flatMap((block): OmpPromptImage[] => {
      if (block.type !== 'image' || !block.image.data) return [];
      return [{
        data: block.image.data,
        mimeType: block.image.mediaType,
        type: 'image',
      }];
    })],
    text,
  };
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input
    .filter((block): block is { readonly type: 'text'; readonly text: string } =>
      block.type === 'text')
    .map(block => block.text)
    .join('\n\n');
}

function isAssistantChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'text'
    || chunk.type === 'thinking'
    || chunk.type === 'citations'
    || chunk.type === 'tool_use'
    || chunk.type === 'subagent_tool_use';
}

function getFirstRejectedError(
  results: readonly PromiseSettledResult<void>[],
): Error | null {
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  return rejected ? toError(rejected.reason) : null;
}

function isSamePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function classifyError(
  error: unknown,
  category?: ProviderExecutionErrorCategory,
  stderr?: string,
): {
  category: ProviderExecutionErrorCategory;
  message: string;
  recoverable: boolean;
} {
  const baseMessage = error instanceof Error
    ? error.message
    : 'OMP execution failed.';
  const message = stderr?.trim()
    ? `${baseMessage}\n\n${stderr.trim()}`
    : baseMessage;
  const resolvedCategory = category
    ?? ((error instanceof OmpConfigurationError || error instanceof ProviderModelUnavailableError)
      ? 'configuration'
      : /closed|transport/i.test(baseMessage)
        ? 'transport'
        : 'provider');
  return {
    category: resolvedCategory,
    message,
    recoverable: resolvedCategory !== 'configuration',
  };
}

function getOmpMissingSessionTarget(
  launchSpec: OmpLaunchSpec,
  stderr: string,
): string | null {
  const sessionFlagIndex = launchSpec.args.indexOf('--resume');
  const target = launchSpec.args[sessionFlagIndex + 1]?.trim();
  if (sessionFlagIndex < 0 || !target) {
    return null;
  }
  // OMP reports: Error: Session "<target>" not found.
  const missingPattern = new RegExp(`Session "${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" not found\\.`);
  return missingPattern.test(stderr) ? target : null;
}

/** Prompt acceptance: extensions may report a disposition; local-only commands answer with agentInvoked: false. */
interface OmpPromptAck {
  disposition?: string;
  data?: { agentInvoked?: boolean };
}

function extractStateRecord(response: unknown): Record<string, unknown> {
  const record = getRecord(response);
  return getRecord(record.state ?? record.session ?? response);
}

interface ReportedOmpSessionIdentity {
  readonly sessionFile: string | null;
  readonly sessionId: string | null;
}

function extractReportedOmpSessionIdentity(response: unknown): ReportedOmpSessionIdentity {
  const state = extractStateRecord(response);
  return {
    sessionFile: getString(state.sessionFile)
      ?? getString(state.session_file)
      ?? getString(state.sessionPath)
      ?? getString(state.session_path)
      ?? getString(state.path),
    sessionId: getString(state.sessionId)
      ?? getString(state.session_id)
      ?? getString(getRecord(state.session).id),
  };
}

function matchesExpectedOmpSession(
  expectedTarget: string,
  expectedState: OmpProviderState,
  reported: ReportedOmpSessionIdentity,
): boolean {
  const expectedFile = expectedState.sessionFile
    ?? (isOmpSessionPathReference(expectedState.sessionId)
      ? expectedState.sessionId
      : isOmpSessionPathReference(expectedTarget)
        ? expectedTarget
        : null);
  const expectedId = expectedState.sessionId
    && !isOmpSessionPathReference(expectedState.sessionId)
    ? expectedState.sessionId
    : !isOmpSessionPathReference(expectedTarget)
      ? expectedTarget
      : null;
  let compared = false;

  if (expectedFile && reported.sessionFile) {
    compared = true;
    if (!isSamePath(expectedFile, reported.sessionFile)) return false;
  }
  if (expectedId && reported.sessionId) {
    compared = true;
    if (expectedId !== reported.sessionId) return false;
  }
  return compared;
}

function findLastRoleId(
  entries: ReturnType<typeof resolveOmpActivePath>,
  role: string,
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (getString(entries[index].message?.role) === role) {
      return entries[index].id ?? null;
    }
  }
  return null;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
