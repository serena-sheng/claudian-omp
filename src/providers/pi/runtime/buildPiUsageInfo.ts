import type { UsageInfo } from '../../../core/types';

/**
 * Per-turn token consumption, as a delta of the session-cumulative totals the
 * `get_session_stats` RPC reports under `tokens`. The execution session owns
 * the cumulative bookkeeping; this builder stays a pure function.
 */
export interface PiTurnTokenDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Session-cumulative token totals reported by `get_session_stats` (`tokens`). */
export interface PiSessionTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Reads the session-cumulative `tokens` block, or null when stats do not carry one. */
export function readPiSessionTokenTotals(response: unknown): PiSessionTokenTotals | null {
  const tokens = getRecord(response).tokens;
  if (tokens === undefined) return null;
  const record = getRecord(tokens);
  return {
    input: getNumber(record.input) ?? 0,
    output: getNumber(record.output) ?? 0,
    cacheRead: getNumber(record.cacheRead) ?? getNumber(record.cache_read) ?? 0,
    cacheWrite: getNumber(record.cacheWrite) ?? getNumber(record.cache_write) ?? 0,
  };
}

/**
 * Diffs two cumulative snapshots; the first read counts as the full delta and
 * regressions (session reload, compaction of counters) clamp to zero.
 */
export function diffPiSessionTokenTotals(
  previous: PiSessionTokenTotals | null,
  current: PiSessionTokenTotals,
): PiTurnTokenDelta {
  const delta = (next: number, prior: number | undefined): number => Math.max(0, next - (prior ?? 0));
  return {
    input: delta(current.input, previous?.input),
    output: delta(current.output, previous?.output),
    cacheRead: delta(current.cacheRead, previous?.cacheRead),
    cacheWrite: delta(current.cacheWrite, previous?.cacheWrite),
  };
}

/**
 * What one `get_session_stats` read contributes to metering.
 *
 * The counters are session-cumulative, so a turn is normally the difference
 * against the previous read. A session that adopted an existing native session
 * (resume) opens with counters that belong to earlier work: that first read is
 * a baseline and is billed as nothing. `undefined` means the payload carried no
 * cumulative block at all, leaving callers on their previous behaviour.
 */
export function resolvePiTurnTokens(params: {
  adopted: boolean;
  current: PiSessionTokenTotals | null;
  previous: PiSessionTokenTotals | null;
}): PiTurnTokenDelta | undefined {
  if (params.current === null) return undefined;
  if (params.adopted && params.previous === null) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return diffPiSessionTokenTotals(params.previous, params.current);
}

export function buildPiUsageInfo(
  response: unknown,
  model: string | null,
  catalogContextWindow?: number,
  turnTokens?: PiTurnTokenDelta,
): UsageInfo | null {
  const stats = getRecord(response);
  const contextUsage = getRecord(stats.contextUsage ?? stats.context_usage ?? stats);
  const providerContextWindow = getPositiveNumber(contextUsage.contextWindow)
    ?? getPositiveNumber(contextUsage.context_window)
    ?? getPositiveNumber(contextUsage.window);
  const contextWindow = providerContextWindow ?? getPositiveNumber(catalogContextWindow) ?? 0;
  const contextTokens = getNumber(contextUsage.contextTokens)
    ?? getNumber(contextUsage.context_tokens)
    ?? getNumber(contextUsage.tokens)
    ?? getNumber(contextUsage.used)
    ?? 0;
  const inputTokens = turnTokens?.input
    ?? getNumber(contextUsage.inputTokens)
    ?? getNumber(contextUsage.input_tokens)
    ?? contextTokens;

  if (contextTokens === 0 && inputTokens === 0) {
    return null;
  }

  return {
    cacheCreationInputTokens: turnTokens?.cacheWrite
      ?? getNumber(contextUsage.cacheCreationInputTokens)
      ?? getNumber(contextUsage.cache_creation_input_tokens)
      ?? 0,
    cacheReadInputTokens: turnTokens?.cacheRead
      ?? getNumber(contextUsage.cacheReadInputTokens)
      ?? getNumber(contextUsage.cache_read_input_tokens)
      ?? 0,
    contextTokens,
    contextWindow,
    inputTokens,
    ...(model ? { model } : {}),
    ...(turnTokens ? { outputTokens: turnTokens.output } : {}),
    percentage: normalizePiUsagePercentage(
      getNumber(contextUsage.percentage),
      contextTokens,
      contextWindow,
    ),
  };
}

function normalizePiUsagePercentage(
  providerPercentage: number | null,
  contextTokens: number,
  contextWindow: number,
): number {
  const rawPercentage = providerPercentage
    ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);
  const wholePercentage = providerPercentage !== null && rawPercentage >= 0 && rawPercentage <= 1
    ? rawPercentage * 100
    : rawPercentage;

  return Math.min(100, Math.max(0, Math.round(wholePercentage)));
}

function getRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getPositiveNumber(value: unknown): number | null {
  const number = getNumber(value);
  return number !== null && number > 0 ? number : null;
}
