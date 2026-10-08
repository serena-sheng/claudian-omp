import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildImageAttachmentFromBase64 } from '@/core/execution/imageAttachment';
import { extractUserQuery } from '@/core/prompt/promptContext';
import { resolveToolDiffData } from '@/core/tools/toolDiff';

import { isWriteEditTool } from '../../../core/tools/toolNames';
import type { ChatMessage, ContentBlock, ImageAttachment, ToolCallInfo, TurnStats } from '../../../core/types';
import { createTurnStats, isTokenCount } from '../../../core/types';
import { encodeOmpModelId } from '../models';
import { getOmpCustomMessageDisplayText } from '../normalization/ompCustomMessageNormalization';
import {
  extractOmpToolResultText,
  normalizeOmpToolInput,
  normalizeOmpToolName,
  normalizeOmpToolResultDetails,
} from '../normalization/ompToolNormalization';
import type { OmpTreeCursor } from '../types';
import { decodeOmpRecoveryPrompt } from './OmpRecoveryPromptCodec';

export interface OmpSessionEntry {
  id?: string;
  message?: Record<string, unknown>;
  parentId?: string;
  raw: Record<string, unknown>;
  type: string;
}

export interface ParsedOmpSessionEntries {
  entries: OmpSessionEntry[];
  header: Record<string, unknown> | null;
}

export interface ParseOmpSessionContentOptions {
  leafEntryId?: string | null;
  includeBranches?: boolean;
  requireLeafEntryId?: boolean;
  syntheticIdNamespace?: string;
}

export interface CreateOmpForkSessionFileOptions {
  now?: Date;
  sessionDir?: string;
  sessionId?: string;
  targetCwd?: string;
}

export interface CreatedOmpForkSessionFile {
  leafEntryId: string;
  parentSession: string;
  sessionFile: string;
  sessionId: string;
}

interface OmpForkRollbackOwnership {
  flight: Promise<void> | null;
  readonly parentSession: string;
  readonly sessionFile: string;
}

const rollbackEligibleForkTargets = new WeakMap<
  CreatedOmpForkSessionFile,
  OmpForkRollbackOwnership
>();

export function parseOmpSessionContent(
  content: string | ParsedOmpSessionEntries,
  options: ParseOmpSessionContentOptions = {},
): ChatMessage[] {
  const parsed = typeof content === 'string' ? parseOmpSessionEntries(content) : content;
  if (options.leafEntryId === null) return [];
  const leafEntryId = options.leafEntryId?.trim();
  if (
    options.requireLeafEntryId
    && (!leafEntryId || !parsed.entries.some(entry => entry.id === leafEntryId))
  ) {
    return [];
  }

  const messages = mapOmpSessionEntries(
    resolveOmpActivePath(parsed.entries, leafEntryId),
    options.syntheticIdNamespace,
  );
  if (options.includeBranches !== false) {
    const branches = getOmpConversationBranches(parsed.entries);
    for (const message of messages) {
      if (message.userMessageId && branches[message.userMessageId]) {
        message.treeBranches = branches[message.userMessageId];
      }
    }
  }
  return messages;
}

/** Configuration entries between prompts do not create conversation alternatives. */
/** Match ordered gaps between native IDs, preserving unconsumed steering input as unbound. */
export function correlateOmpUserMessages(live: readonly ChatMessage[], native: readonly ChatMessage[]): Record<string, string> {
  const users = live.filter(message => message.role === 'user' && !message.isInterrupt && !message.isRebuiltContext);
  const nativeUsers = native.filter(message => message.role === 'user' && message.userMessageId);
  const nativeIndexes = new Map(nativeUsers.map((message, index) => [message.userMessageId!, index]));
  const result: Record<string, string> = {};
  let localStart = 0;
  let nativeStart = 0;
  const matchGap = (localEnd: number, nativeEnd: number) => {
    const nativeCount = nativeEnd - nativeStart;
    if (localEnd - localStart < nativeCount) return;
    const gap = users.slice(localStart, localStart + nativeCount);
    if (localEnd - localStart > nativeCount) {
      // Only main submitted inputs carry an accepted execution snapshot. Extra
      // steering rows can be acknowledged locally before OMP consumes the queue.
      if (!gap.every(message => message.executionInput)
        || users.slice(localStart + nativeCount, localEnd).some(message => message.executionInput)) return;
    }
    if (!gap.every((message, offset) => {
      const candidate = nativeUsers[nativeStart + offset];
      const text = (item: ChatMessage) => extractUserQuery(item.displayContent ?? item.content);
      return !message.userMessageId && text(message) === text(candidate)
        && (message.images?.length ?? 0) === (candidate.images?.length ?? 0)
        && (message.images ?? []).every((image, index) => image.data === candidate.images![index].data
          && image.mediaType === candidate.images![index].mediaType);
    })) return;
    gap.forEach((message, offset) => { result[message.id] = nativeUsers[nativeStart + offset].userMessageId!; });
  };
  for (let index = 0; index < users.length; index++) {
    const id = users[index].userMessageId;
    if (!id) continue;
    const nativeIndex = nativeIndexes.get(id);
    if (nativeIndex === undefined) {
      // Previous-session messages precede the active native transcript.
      if (nativeStart === 0) localStart = index + 1;
      continue;
    }
    if (nativeIndex < nativeStart) continue;
    matchGap(index, nativeIndex);
    result[users[index].id] = id;
    localStart = index + 1;
    nativeStart = nativeIndex + 1;
  }
  matchGap(users.length, nativeUsers.length);
  return result;
}

export function getOmpConversationBranches(entries: readonly OmpSessionEntry[]): Record<string, string[]> {
  const byId = new Map(entries.filter(entry => entry.id).map(entry => [entry.id!, entry]));
  const groups = new Map<string | undefined, string[]>();
  for (const entry of entries) {
    if (!entry.id || entry.message?.role !== 'user') continue;
    if (!entry.parentId && entry.raw.parentId !== null && entry.raw.parent_id !== null) continue;
    let parent = entry.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor || ancestor.message || ancestor.type === 'branch_summary') break;
      parent = ancestor.parentId;
    }
    const group = groups.get(parent) ?? [];
    group.push(entry.id);
    groups.set(parent, group);
  }
  return Object.fromEntries([...groups.values()].flatMap(ids => ids.map(id => [id, ids])));
}

/** Native appends after a selected cursor include interrupted turns and configuration entries. */
export function resolveOmpTreeCursor(entries: OmpSessionEntry[], cursor: OmpTreeCursor): OmpTreeCursor {
  const latest = entries.at(-1)?.id;
  if (!cursor.appendId || !latest || latest === cursor.appendId) return cursor;
  if (!entries.some(entry => entry.id === cursor.appendId)) throw new Error('OMP branch history changed since navigation.');
  const path = resolveOmpActivePath(entries, latest);
  if (cursor.leafId !== null && !path.some(entry => entry.id === cursor.leafId)) return cursor;
  return { targetId: latest, leafId: latest, appendId: latest };
}

export function parseOmpSessionModel(
  content: string | ParsedOmpSessionEntries,
  leafEntryId?: string | null,
): string | null {
  if (leafEntryId === null) return null;
  const parsed = typeof content === 'string' ? parseOmpSessionEntries(content) : content;
  const persistedLeafEntryId = leafEntryId?.trim();
  if (
    persistedLeafEntryId
    && !parsed.entries.some(entry => entry.id === persistedLeafEntryId)
  ) {
    return null;
  }
  const entries = resolveOmpActivePath(parsed.entries, persistedLeafEntryId);
  let selection: string | null = null;
  for (const entry of entries) {
    const provider = getString(entry.raw.provider)
      ?? getString(entry.message?.provider);
    const modelId = getString(entry.raw.modelId)
      ?? getString(entry.message?.model);
    if (provider && modelId) {
      selection = encodeOmpModelId(provider, modelId);
    }
  }
  return selection;
}

export function parseOmpSessionEntries(content: string): ParsedOmpSessionEntries {
  const entries: OmpSessionEntry[] = [];
  let header: Record<string, unknown> | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isPlainObject(parsed)) {
        continue;
      }
      record = parsed;
    } catch {
      continue;
    }

    const type = getString(record.type) ?? getString(record.kind) ?? '';
    if (type === 'session') {
      header = record;
      continue;
    }

    const message = getRecord(record.message) ?? getRecord(record.data) ?? inferMessageRecord(record);
    entries.push({
      ...(getString(record.id) ? { id: getString(record.id)! } : {}),
      ...(message ? { message } : {}),
      ...(getString(record.parentId) ?? getString(record.parent_id)
        ? { parentId: (getString(record.parentId) ?? getString(record.parent_id))! }
        : {}),
      raw: record,
      type,
    });
  }

  return { entries, header };
}

export async function readOmpSessionHeader(
  sessionFile: string,
): Promise<Record<string, unknown> | null> {
  const maxHeaderBytes = 64 * 1024;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(sessionFile, 'r');
    const buffer = Buffer.alloc(maxHeaderBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = content.search(/\r?\n/);
    if (newlineIndex === -1 && bytesRead === maxHeaderBytes) {
      return null;
    }
    const firstLine = newlineIndex === -1 ? content : content.slice(0, newlineIndex);
    const parsed = JSON.parse(firstLine) as unknown;
    if (!isPlainObject(parsed) || getString(parsed.type) !== 'session') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function resolveOmpActivePath(entries: OmpSessionEntry[], leafId?: string): OmpSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is OmpSessionEntry & { id: string } => !!entry.id);
  if (entriesWithIds.length === 0) {
    return entries;
  }

  const hasBranchGraph = hasOmpBranchGraph(entriesWithIds);
  if (!leafId && !hasBranchGraph) {
    return entries;
  }

  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  const targetLeafId = leafId && byId.has(leafId)
    ? leafId
    : entriesWithIds[entriesWithIds.length - 1]?.id;
  if (!targetLeafId) {
    return entries;
  }

  const activePath = hasBranchGraph
    ? resolveOmpGraphEntryPath(byId, targetLeafId)
    : resolveOmpLinearEntryPath(entries, targetLeafId);
  if (activePath.length === 0) {
    return entries;
  }

  return hasBranchGraph
    ? includeOmpGraphPathEntries(entries, activePath)
    : includeOmpLinearPathEntries(entries, activePath);
}

function resolveOmpEntryPath(entries: OmpSessionEntry[], leafId: string): OmpSessionEntry[] {
  const entriesWithIds = entries.filter((entry): entry is OmpSessionEntry & { id: string } => !!entry.id);
  const byId = new Map(entriesWithIds.map(entry => [entry.id, entry] as const));
  if (!byId.has(leafId)) {
    return [];
  }

  const hasBranchGraph = hasOmpBranchGraph(entriesWithIds);
  const activePath = hasBranchGraph
    ? resolveOmpGraphEntryPath(byId, leafId)
    : resolveOmpLinearEntryPath(entries, leafId);
  if (activePath.length === 0) {
    return [];
  }

  return hasBranchGraph
    ? includeOmpGraphPathEntries(entries, activePath)
    : includeOmpLinearPathEntries(entries, activePath);
}

function hasOmpBranchGraph(entriesWithIds: OmpSessionEntry[]): boolean {
  return entriesWithIds.some(entry => !!entry.parentId && !isToolResultEntry(entry));
}

function resolveOmpGraphEntryPath(
  byId: Map<string, OmpSessionEntry>,
  targetLeafId: string,
): OmpSessionEntry[] {
  const activePath: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  let current: OmpSessionEntry | undefined = byId.get(targetLeafId);
  while (current) {
    if (!current.id || seen.has(current.id)) {
      break;
    }
    seen.add(current.id);
    activePath.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return activePath;
}

function resolveOmpLinearEntryPath(entries: OmpSessionEntry[], targetLeafId: string): OmpSessionEntry[] {
  const leafIndex = entries.findIndex(entry => entry.id === targetLeafId);
  if (leafIndex < 0) {
    return [];
  }
  return entries.slice(0, leafIndex + 1);
}

function includeOmpGraphPathEntries(
  entries: OmpSessionEntry[],
  activePath: OmpSessionEntry[],
): OmpSessionEntry[] {
  const activeIds = new Set(activePath.map(entry => entry.id).filter((id): id is string => !!id));
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (isToolResultEntry(entry)) {
      const toolCallId = getToolResultCallId(entry);
      return (!!toolCallId && activeToolCallIds.has(toolCallId))
        || (!!entry.id && activeIds.has(entry.id))
        || (!!entry.parentId && activeIds.has(entry.parentId));
    }
    if (entry.id) {
      return activeIds.has(entry.id);
    }
    if (entry.parentId && activeIds.has(entry.parentId)) {
      return true;
    }
    return false;
  });
}

function includeOmpLinearPathEntries(
  entries: OmpSessionEntry[],
  activePath: OmpSessionEntry[],
): OmpSessionEntry[] {
  const activeEntries = new Set(activePath);
  const activeToolCallIds = collectToolCallIds(activePath);
  return entries.filter((entry) => {
    if (activeEntries.has(entry)) {
      return true;
    }
    if (!isToolResultEntry(entry)) {
      return false;
    }
    const toolCallId = getToolResultCallId(entry);
    return !!toolCallId && activeToolCallIds.has(toolCallId);
  });
}

export async function createOmpForkSessionFile(
  sourceSessionFile: string,
  resumeAt: string,
  options: CreateOmpForkSessionFileOptions = {},
): Promise<CreatedOmpForkSessionFile> {
  const sourceContent = await fsp.readFile(sourceSessionFile, 'utf-8');
  const parsed = parseOmpSessionEntries(sourceContent);
  const branchEntries = resolveOmpEntryPath(parsed.entries, resumeAt);
  if (branchEntries.length === 0) {
    throw new Error(`OMP fork checkpoint not found: ${resumeAt}`);
  }

  const timestamp = options.now ?? new Date();
  const timestampText = timestamp.toISOString();
  const sessionId = options.sessionId ?? randomUUID();
  const sessionDir = options.sessionDir ?? path.dirname(sourceSessionFile);
  const sessionFile = path.join(
    sessionDir,
    `${timestampText.replace(/[:.]/g, '-')}_${sessionId}.jsonl`,
  );
  const sourceCwd = typeof parsed.header?.cwd === 'string' && parsed.header.cwd.trim()
    ? parsed.header.cwd.trim()
    : process.cwd();
  const header = {
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: timestampText,
    cwd: options.targetCwd ?? sourceCwd,
    parentSession: sourceSessionFile,
  };
  const lines = [
    JSON.stringify(header),
    ...branchEntries.map(entry => JSON.stringify(entry.raw)),
  ];

  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.writeFile(sessionFile, `${lines.join('\n')}\n`, { flag: 'wx' });

  const created = {
    leafEntryId: resumeAt,
    parentSession: sourceSessionFile,
    sessionFile,
    sessionId,
  };
  rollbackEligibleForkTargets.set(created, {
    flight: null,
    parentSession: sourceSessionFile,
    sessionFile,
  });
  return created;
}

export async function rollbackCreatedOmpForkSessionFile(
  created: CreatedOmpForkSessionFile,
): Promise<void> {
  const ownership = rollbackEligibleForkTargets.get(created);
  if (!ownership) {
    throw new Error('OMP fork rollback target is not owned by this process.');
  }
  if (!ownership.flight) {
    ownership.flight = (async () => {
      if (path.resolve(ownership.sessionFile) === path.resolve(ownership.parentSession)) {
        throw new Error('OMP fork rollback cannot remove the source session.');
      }
      await fsp.unlink(ownership.sessionFile);
      rollbackEligibleForkTargets.delete(created);
    })();
  }
  return ownership.flight;
}

export function findOmpSessionFile(
  sessionIdOrFile: string,
  cwd?: string | null,
  sessionDir?: string | null,
): string | null {
  const trimmed = sessionIdOrFile.trim();
  if (!trimmed) {
    return null;
  }

  if (path.isAbsolute(trimmed) && fileExists(trimmed)) {
    return trimmed;
  }

  const roots = [
    sessionDir,
    cwd ? path.join(cwd, '.omp', 'agent', 'sessions') : null,
    path.join(os.homedir(), '.omp', 'agent', 'sessions'),
  ].filter((root): root is string => !!root);

  for (const root of roots) {
    const direct = path.join(root, trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.jsonl`);
    if (fileExists(direct)) {
      return direct;
    }

    const found = findSessionFileInRoot(root, trimmed);
    if (found) {
      return found;
    }
  }

  return null;
}

/** Searches exactly one caller-owned root without adding implicit fallback roots. */
export function findOmpSessionFileInRoot(
  sessionId: string,
  root: string,
): string | null {
  const trimmed = sessionId.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /[\\/]/.test(trimmed)) {
    return null;
  }

  const direct = path.join(root, trimmed.endsWith('.jsonl') ? trimmed : `${trimmed}.jsonl`);
  if (fileExists(direct)) {
    return direct;
  }
  return findSessionFileInRoot(root, trimmed);
}

function mapOmpSessionEntries(
  entries: OmpSessionEntry[],
  syntheticIdNamespace?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turnStartedAt: number | undefined;
  // An extension message outside a prompted turn starts an automatic response.
  let promptedTurnOpen = false;
  const stats = new OmpTurnStats();

  for (const entry of entries) {
    const mapped = mapOmpSessionEntry(entry, messages, syntheticIdNamespace);
    if (mapped) {
      if (entry.type === 'custom_message' && !promptedTurnOpen) mapped.isAutomaticResponse = true;
      const previous = messages[messages.length - 1];
      // Results steered into a prompted turn stay in its response, as live output renders them.
      const continuesResponse = isAssistantMessageEntry(entry)
        || (entry.type === 'custom_message' && promptedTurnOpen);
      if (continuesResponse && canMergeAssistantContinuation(previous, mapped)) {
        mergeAssistantContinuation(previous, mapped);
      } else {
        messages.push(mapped);
      }

      const nativeMessage = entry.message ?? entry.raw;
      const turnStats = stats.add(entry);
      if (mapped.role === 'user') {
        promptedTurnOpen = true;
        turnStartedAt = parseTimestamp(nativeMessage.timestamp) ?? parseTimestamp(entry.raw.timestamp);
      } else if (isBoundaryMessage(mapped)) {
        promptedTurnOpen = false;
        turnStartedAt = undefined;
      } else if (isAssistantMessageEntry(entry)) {
        const stopReason = getString(nativeMessage.stopReason);
        // OMP's inner assistant timestamp is generation start; the entry is written on completion.
        const completedAt = parseTimestamp(entry.raw.timestamp);
        if ((stopReason === 'stop' || stopReason === 'length')
          && turnStartedAt !== undefined && completedAt !== undefined && completedAt >= turnStartedAt) {
          messages[messages.length - 1].turnStats = turnStats;
          messages[messages.length - 1].completedAt = completedAt;
          messages[messages.length - 1].durationSeconds = Math.floor((completedAt - turnStartedAt) / 1_000);
        }
        if (stopReason && stopReason !== 'toolUse') {
          promptedTurnOpen = false;
          turnStartedAt = undefined;
        }
      }
    }
  }

  return messages;
}

/** Account on the resolved native branch; tool results never contribute usage. */
class OmpTurnStats {
  private startedAt: number | undefined;
  private outputTokens: number | undefined = 0;

  add(entry: OmpSessionEntry): TurnStats | undefined {
    const message = entry.message ?? entry.raw;
    const role = getString(message.role) ?? inferRole(entry.type);
    if (role === 'user') {
      if (isHiddenOmpRecoveryInput(message)) return undefined;
      this.startedAt = parseTimestamp(message.timestamp) ?? parseTimestamp(entry.raw.timestamp);
      this.outputTokens = 0;
    } else if (entry.type === 'compaction') {
      this.startedAt = undefined;
    } else if (role === 'assistant') {
      const output = getRecord(message.usage)?.output;
      this.outputTokens = this.outputTokens !== undefined && isTokenCount(output)
        ? this.outputTokens + output : undefined;
      const stopReason = getString(message.stopReason);
      const completedAt = parseTimestamp(entry.raw.timestamp);
      const stats = (stopReason === 'stop' || stopReason === 'length')
        && this.startedAt !== undefined && completedAt !== undefined
        ? createTurnStats(this.outputTokens, completedAt - this.startedAt) : undefined;
      if (stopReason && stopReason !== 'toolUse') this.startedAt = undefined;
      return stats;
    }
    return undefined;
  }
}

export function getOmpTurnStats(entries: OmpSessionEntry[], assistantId: string | undefined): TurnStats | undefined {
  const stats = new OmpTurnStats();
  for (const entry of entries) {
    const result = stats.add(entry);
    if (assistantId && entry.id === assistantId) return result;
  }
  return undefined;
}

function isAssistantMessageEntry(entry: OmpSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return (getString(message.role) ?? inferRole(entry.type)) === 'assistant';
}

function isBoundaryMessage(message: ChatMessage): boolean {
  return message.contentBlocks?.some(block => block.type === 'context_compacted') === true;
}

function canMergeAssistantContinuation(
  previous: ChatMessage | undefined,
  next: ChatMessage,
): previous is ChatMessage {
  return previous?.role === 'assistant'
    && next.role === 'assistant'
    && !isBoundaryMessage(previous)
    && !isBoundaryMessage(next);
}

function mergeAssistantContinuation(target: ChatMessage, source: ChatMessage): void {
  target.content += source.content;
  target.assistantMessageId = source.assistantMessageId ?? target.assistantMessageId;

  if (source.contentBlocks && source.contentBlocks.length > 0) {
    target.contentBlocks = [
      ...(target.contentBlocks ?? []),
      ...source.contentBlocks,
    ];
  }

  if (source.toolCalls && source.toolCalls.length > 0) {
    const existingToolIds = new Set(target.toolCalls?.map(toolCall => toolCall.id) ?? []);
    const newToolCalls = source.toolCalls.filter(toolCall => !existingToolIds.has(toolCall.id));
    if (newToolCalls.length > 0) {
      target.toolCalls = [
        ...(target.toolCalls ?? []),
        ...newToolCalls,
      ];
    }
  }
}

function mapOmpSessionEntry(
  entry: OmpSessionEntry,
  messages: ChatMessage[],
  syntheticIdNamespace?: string,
): ChatMessage | null {
  const message = entry.message ?? entry.raw;
  const role = getString(message.role) ?? inferRole(entry.type);
  const timestamp = getTimestamp(message.timestamp ?? entry.raw.timestamp);

  if (role === 'user') {
    const rawContent = extractTextContent(message.content ?? message.text ?? message.message);
    const recoveryPrompt = decodeOmpRecoveryPrompt(rawContent);
    const content = recoveryPrompt?.currentInput ?? (recoveryPrompt ? '' : rawContent);
    const displayContent = extractOmpSkillDisplayContent(content);
    const messageId = entry.id ?? createSyntheticOmpMessageId(
      'user',
      messages.length,
      syntheticIdNamespace,
    );
    const images = extractUserImages(
      message.content ?? message.parts ?? message.blocks,
      messageId,
    );
    if (isHiddenOmpRecoveryInput(message, images.length > 0)) {
      return null;
    }
    return {
      content,
      ...(displayContent ? { displayContent } : {}),
      id: messageId,
      ...(images.length > 0 ? { images } : {}),
      role: 'user',
      timestamp,
      userMessageId: entry.id,
    };
  }

  if (role === 'assistant') {
    const contentBlocks = extractAssistantContentBlocks(message.content ?? message.parts ?? message.blocks);
    const toolCalls = extractAssistantToolCalls(message.content ?? message.parts ?? message.blocks);
    const text = contentBlocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.content)
      .join('');

    return {
      assistantMessageId: entry.id,
      content: text,
      ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
      id: entry.id ?? createSyntheticOmpMessageId(
        'assistant',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (isToolResultEntry(entry)) {
    applyToolResult(messages, entry);
    return null;
  }

  if (entry.type === 'compaction') {
    return {
      content: '',
      contentBlocks: [{ type: 'context_compacted' }],
      id: entry.id ?? createSyntheticOmpMessageId(
        'compaction',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
    };
  }

  if (entry.type === 'custom_message') {
    // Extension messages render as notifications, as live output renders them.
    const content = getOmpCustomMessageDisplayText(entry.raw);
    if (!content) return null;
    return {
      content: '',
      contentBlocks: [{ type: 'task_notification', content }],
      id: entry.id ?? createSyntheticOmpMessageId(
        'notice',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
    };
  }

  if (
    (entry.type === 'branch_summary' || entry.type === 'compactionSummary')
    && entry.raw.display !== false
  ) {
    const content = extractTextContent(entry.raw.content ?? entry.raw.summary ?? entry.raw.message);
    if (!content) {
      return null;
    }
    return {
      content,
      contentBlocks: [{ type: 'text', content }],
      id: entry.id ?? createSyntheticOmpMessageId(
        'notice',
        messages.length,
        syntheticIdNamespace,
      ),
      role: 'assistant',
      timestamp,
    };
  }

  return null;
}

function isHiddenOmpRecoveryInput(message: Record<string, unknown>, hasImages?: boolean): boolean {
  const content = extractTextContent(message.content ?? message.text ?? message.message);
  if (decodeOmpRecoveryPrompt(content)?.currentInput !== null) return false;
  return !(hasImages ?? (extractUserImages(message.content ?? message.parts ?? message.blocks, 'recovery').length > 0));
}

function createSyntheticOmpMessageId(
  kind: string,
  index: number,
  namespace?: string,
): string {
  const localId = `omp-${kind}-${index}`;
  return namespace ? `${namespace}:${localId}` : localId;
}

function extractOmpSkillDisplayContent(content: string): string | undefined {
  const match = content.match(
    /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return undefined;

  const visibleArguments = match[2] ? extractUserQuery(match[2]) : '';
  return `/skill:${match[1]}${visibleArguments ? ` ${visibleArguments}` : ''}`;
}

function extractAssistantContentBlocks(value: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const parts = Array.isArray(value) ? value : [{ type: 'text', text: extractTextContent(value) }];

  for (const part of parts) {
    if (!isPlainObject(part)) {
      continue;
    }

    const type = getString(part.type);
    if (type === 'thinking' || type === 'reasoning') {
      const content = extractTextContent(part.thinking ?? part.text ?? part.content);
      if (content) {
        blocks.push({ type: 'thinking', content });
      }
      continue;
    }

    if (type === 'toolCall' || type === 'tool_call' || type === 'toolUse' || type === 'tool_use') {
      const toolId = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
      if (toolId) {
        blocks.push({ type: 'tool_use', toolId });
      }
      continue;
    }

    const content = extractTextContent(part.text ?? part.content);
    if (content) {
      blocks.push({ type: 'text', content });
    }
  }

  return blocks;
}

function extractUserImages(value: unknown, messageId: string): ImageAttachment[] {
  const parts = Array.isArray(value) ? value : [];
  const images: ImageAttachment[] = [];

  for (const part of parts) {
    if (!isPlainObject(part)) {
      continue;
    }

    const type = getString(part.type);
    if (type !== 'image') {
      continue;
    }

    const data = getString(part.data);
    const mediaType = getString(part.mimeType) ?? getString(part.mime_type) ?? getString(part.mediaType);
    if (!data || !mediaType) {
      continue;
    }

    const image = buildImageAttachmentFromBase64({
      data,
      id: `omp-img-${messageId}-${images.length}`,
      mediaType,
      name: getString(part.name) ?? getString(part.filename) ?? `image-${images.length + 1}.${mediaType.split('/')[1] ?? 'img'}`,
    });
    if (image) {
      images.push(image);
    }
  }

  return images;
}

function extractAssistantToolCalls(value: unknown): ToolCallInfo[] {
  const parts = Array.isArray(value) ? value : [];
  return parts.flatMap((part): ToolCallInfo[] => {
    if (!isPlainObject(part)) {
      return [];
    }

    const type = getString(part.type);
    if (type !== 'toolCall' && type !== 'tool_call' && type !== 'toolUse' && type !== 'tool_use') {
      return [];
    }

    const id = getString(part.id) ?? getString(part.toolCallId) ?? getString(part.callId);
    const rawName = getString(part.name) ?? getString(part.tool) ?? getString(part.toolName);
    if (!id || !rawName) {
      return [];
    }
    const name = normalizeOmpToolName(rawName);

    return [{
      id,
      input: normalizeOmpToolInput(part.input ?? part.arguments ?? part.args, name),
      name,
      status: 'running',
    }];
  });
}

function collectToolCallIds(entries: OmpSessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    const message = entry.message ?? entry.raw;
    const parts = message.content ?? message.parts ?? message.blocks;
    for (const toolCall of extractAssistantToolCalls(parts)) {
      ids.add(toolCall.id);
    }
  }
  return ids;
}

function isToolResultEntry(entry: OmpSessionEntry): boolean {
  const message = entry.message ?? entry.raw;
  return entry.type === 'toolResult'
    || entry.type === 'tool_result'
    || getString(message.role) === 'toolResult'
    || getString(message.role) === 'tool_result';
}

function getToolResultCallId(entry: OmpSessionEntry): string | null {
  const message = entry.message ?? entry.raw;
  return getString(message.toolCallId)
    ?? getString(message.tool_call_id)
    ?? getString(message.id)
    ?? getString(entry.raw.toolCallId)
    ?? getString(entry.raw.tool_call_id)
    ?? getString(entry.raw.id);
}

function applyToolResult(messages: ChatMessage[], entry: OmpSessionEntry): void {
  const toolCallId = getToolResultCallId(entry);
  if (!toolCallId) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index--) {
    const chatMessage = messages[index];
    const toolCall = chatMessage.toolCalls?.find(call => call.id === toolCallId);
    if (!toolCall) {
      continue;
    }

    const resultMessage = entry.message ?? entry.raw;
    toolCall.status = resultMessage.error === true || resultMessage.isError === true ? 'error' : 'completed';
    toolCall.result = extractOmpToolResultText(toolCall.name, resultMessage.result ?? resultMessage.content ?? resultMessage.output);
    const details = normalizeOmpToolResultDetails(toolCall.name, resultMessage, getNestedCallArguments(resultMessage));
    toolCall.resultFormat = details?.resultFormat;
    if (details?.resultImages) toolCall.resultImages = details.resultImages;
    if (details?.webSearchResults) {
      toolCall.webSearchResults = details.webSearchResults;
    }
    if (details?.scriptToolCalls) {
      toolCall.scriptToolCalls = details.scriptToolCalls;
    }
    if (toolCall.status === 'completed' && isWriteEditTool(toolCall.name)) {
      const diffData = resolveToolDiffData(details?.diff, toolCall);
      if (diffData) {
        toolCall.diffData = diffData;
      }
    }
    return;
  }
}

/** Complete arguments OMP recorded for calls the tool made (`nestedCalls`), by call ID. */
function getNestedCallArguments(resultMessage: Record<string, unknown>): Map<string, unknown> {
  const nestedCalls = resultMessage.nestedCalls;
  const calls = nestedCalls && typeof nestedCalls === 'object' && Array.isArray((nestedCalls as Record<string, unknown>).calls)
    ? (nestedCalls as { calls: unknown[] }).calls
    : [];
  const argumentsById = new Map<string, unknown>();
  for (const call of calls) {
    if (call && typeof call === 'object') {
      const { id, arguments: args } = call as Record<string, unknown>;
      if (typeof id === 'string' && args !== undefined) argumentsById.set(id, args);
    }
  }
  return argumentsById;
}

function inferMessageRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return getString(record.role) ? record : undefined;
}

function inferRole(type: string): string | null {
  if (type === 'user' || type === 'assistant') {
    return type;
  }
  return null;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractTextContent).filter(Boolean).join('');
  }

  if (!isPlainObject(value)) {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  return '';
}

function findSessionFileInRoot(root: string, sessionId: string): string | null {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = findSessionFileInRoot(candidate, sessionId);
        if (nested) {
          return nested;
        }
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && entry.name.includes(sessionId)
      ) {
        return candidate;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getTimestamp(value: unknown): number {
  return parseTimestamp(value) ?? Date.now();
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
