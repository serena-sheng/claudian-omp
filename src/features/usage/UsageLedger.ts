import { CLAUDIAN_STORAGE_PATH } from '@/core/bootstrap/storagePaths';

/** One JSONL line per recorded usage event, under the plugin storage root. */
export const USAGE_LOG_PATH = `${CLAUDIAN_STORAGE_PATH}/usage.jsonl`;

/** Records older than this many days are dropped on load and the log is rewritten. */
const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal storage surface the ledger needs; VaultFileAdapter satisfies it structurally. */
export interface UsageLedgerStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

/** A single recorded usage event. `day` is the local calendar day (YYYY-MM-DD). */
export interface UsageLedgerEntry {
  ts: number;
  day: string;
  conversationId: string;
  providerId: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** What callers report; `ts` defaults to now and `day` is derived locally. */
export type UsageLedgerRecord = Omit<UsageLedgerEntry, 'ts' | 'day'> & { ts?: number };

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

export interface DailyUsage extends UsageTotals {
  day: string;
}

export interface SessionUsage extends UsageTotals {
  conversationId: string;
  providerId: string;
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
  };
}

/** Local calendar day key; lexical order matches chronological order. */
function toLocalDay(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Tolerates partial/corrupt lines; returns null when the entry cannot be trusted. */
function parseEntry(line: string): UsageLedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as { [K in keyof UsageLedgerEntry]?: unknown };
  if (typeof candidate.conversationId !== 'string' || typeof candidate.providerId !== 'string') return null;
  if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) return null;
  return {
    ts: candidate.ts,
    day: typeof candidate.day === 'string' ? candidate.day : toLocalDay(candidate.ts),
    conversationId: candidate.conversationId,
    providerId: candidate.providerId,
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    inputTokens: toCount(candidate.inputTokens),
    outputTokens: toCount(candidate.outputTokens),
    cacheReadInputTokens: toCount(candidate.cacheReadInputTokens),
    cacheCreationInputTokens: toCount(candidate.cacheCreationInputTokens),
  };
}

/**
 * Append-only token usage ledger. Every `usage_updated` event lands as one JSONL
 * line; in-memory aggregates serve the settings UI. Writes are fire-and-forget,
 * serialized, and never throw into the event stream.
 */
export class UsageLedger {
  readonly #adapter: UsageLedgerStorage;
  readonly #byDay = new Map<string, UsageTotals>();
  readonly #bySession = new Map<string, SessionUsage>();
  /** Mirror of the on-disk content, so appends are full-content writes. */
  #fileContent = '';
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(adapter: UsageLedgerStorage) {
    this.#adapter = adapter;
  }

  /** Loads the log, drops entries past retention, and compacts the file when anything was dropped. */
  static async load(adapter: UsageLedgerStorage): Promise<UsageLedger> {
    const ledger = new UsageLedger(adapter);
    let content = '';
    try {
      if (await adapter.exists(USAGE_LOG_PATH)) {
        content = await adapter.read(USAGE_LOG_PATH);
      }
    } catch {
      content = '';
    }
    const cutoff = toLocalDay(Date.now() - RETENTION_DAYS * DAY_MS);
    const entries = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(parseEntry)
      .filter((entry): entry is UsageLedgerEntry => entry !== null);
    const kept = entries.filter(entry => entry.day >= cutoff);
    ledger.#fileContent = kept.length > 0 ? `${kept.map(entry => JSON.stringify(entry)).join('\n')}\n` : '';
    for (const entry of kept) {
      ledger.#accumulate(entry);
    }
    if (kept.length !== entries.length || (content.length > 0 && ledger.#fileContent !== content)) {
      // Compaction: dropped or unparseable lines are rewritten out of the log.
      const rewritten = ledger.#fileContent;
      ledger.#writeChain = ledger.#writeChain
        .then(() => adapter.write(USAGE_LOG_PATH, rewritten))
        .catch(() => undefined);
    }
    return ledger;
  }

  record(input: UsageLedgerRecord): void {
    const ts = input.ts ?? Date.now();
    const entry: UsageLedgerEntry = {
      ts,
      day: toLocalDay(ts),
      conversationId: input.conversationId,
      providerId: input.providerId,
      ...(input.model ? { model: input.model } : {}),
      inputTokens: toCount(input.inputTokens),
      outputTokens: toCount(input.outputTokens),
      cacheReadInputTokens: toCount(input.cacheReadInputTokens),
      cacheCreationInputTokens: toCount(input.cacheCreationInputTokens),
    };
    this.#accumulate(entry);
    this.#enqueueAppend(entry);
  }

  getToday(): UsageTotals {
    return { ...(this.#byDay.get(toLocalDay(Date.now())) ?? emptyTotals()) };
  }

  /** Most recent days first, limited to `limitDays` entries. */
  getDaily(limitDays: number): DailyUsage[] {
    return [...this.#byDay.entries()]
      .map(([day, totals]) => ({ day, ...totals }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, Math.max(0, limitDays));
  }

  getSessionTotals(conversationId: string): UsageTotals | null {
    const totals = this.#bySession.get(conversationId);
    if (!totals) return null;
    const { conversationId: _id, providerId: _provider, ...rest } = totals;
    return { ...rest };
  }

  /** Sessions ordered by total consumption, descending. */
  getTopSessions(limit: number): SessionUsage[] {
    return [...this.#bySession.values()]
      .map(totals => ({ ...totals }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, Math.max(0, limit));
  }

  #accumulate(entry: UsageLedgerEntry): void {
    const add = (totals: UsageTotals): void => {
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadInputTokens += entry.cacheReadInputTokens;
      totals.cacheCreationInputTokens += entry.cacheCreationInputTokens;
      totals.totalTokens += entry.inputTokens + entry.outputTokens
        + entry.cacheReadInputTokens + entry.cacheCreationInputTokens;
    };
    const day = this.#byDay.get(entry.day) ?? emptyTotals();
    add(day);
    this.#byDay.set(entry.day, day);
    const session = this.#bySession.get(entry.conversationId)
      ?? { conversationId: entry.conversationId, providerId: entry.providerId, ...emptyTotals() };
    session.providerId = entry.providerId;
    add(session);
    this.#bySession.set(entry.conversationId, session);
  }

  #enqueueAppend(entry: UsageLedgerEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    this.#fileContent += line;
    const content = this.#fileContent;
    this.#writeChain = this.#writeChain
      .then(() => this.#adapter.write(USAGE_LOG_PATH, content))
      .catch(() => undefined);
  }


  /** Test hook: resolves when every queued write has settled. */
  async flushWritesForTests(): Promise<void> {
    await this.#writeChain;
  }
}

let ledger: UsageLedger | null = null;

/** Called once from the plugin entry point after storage is ready. */
export async function initUsageLedger(adapter: UsageLedgerStorage): Promise<UsageLedger> {
  ledger = await UsageLedger.load(adapter);
  return ledger;
}

/** Null until {@link initUsageLedger} completes; callers must tolerate that. */
export function getUsageLedger(): UsageLedger | null {
  return ledger;
}
