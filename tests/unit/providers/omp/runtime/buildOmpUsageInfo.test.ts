import {
  buildOmpUsageInfo,
  diffOmpSessionTokenTotals,
  readOmpSessionTokenTotals,
  resolveOmpTurnTokens,
} from '@/providers/omp/runtime/buildOmpUsageInfo';

describe('buildOmpUsageInfo', () => {
  it('keeps the context meter from contextUsage when no turn delta is available', () => {
    const usage = buildOmpUsageInfo({
      contextUsage: { contextTokens: 24_691, contextWindow: 200_000, inputTokens: 1200 },
    }, 'omp:deepseek/deepseek-flash');

    expect(usage).toMatchObject({ contextTokens: 24_691, contextWindow: 200_000, percentage: 12 });
    expect(usage?.outputTokens).toBeUndefined();
  });
});

describe('Omp turn token deltas', () => {
  const cumulative = { input: 1000, output: 250, cacheRead: 400, cacheWrite: 60 };

  it('reads the session-cumulative tokens block, tolerating snake_case keys', () => {
    expect(readOmpSessionTokenTotals({ tokens: cumulative })).toEqual(cumulative);
    expect(readOmpSessionTokenTotals({ tokens: { input: 5, output: 6, cache_read: 7, cache_write: 8 } }))
      .toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
    expect(readOmpSessionTokenTotals({ contextUsage: { tokens: 10 } })).toBeNull();
  });

  it('counts the first read as the whole delta and later reads as the difference', () => {
    expect(diffOmpSessionTokenTotals(null, cumulative)).toEqual(cumulative);
    expect(diffOmpSessionTokenTotals(cumulative, { input: 1030, output: 260, cacheRead: 400, cacheWrite: 60 }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('clamps counter regressions to zero instead of reporting negative usage', () => {
    expect(diffOmpSessionTokenTotals(cumulative, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('reports the delta on the usage event while keeping the context meter from contextUsage', () => {
    const usage = buildOmpUsageInfo({
      tokens: { input: 1300, output: 300, cacheRead: 900, cacheWrite: 60 },
      contextUsage: { contextTokens: 20_000, contextWindow: 200_000 },
    }, 'pi:openai/gpt-5', undefined, { input: 30, output: 10, cacheRead: 20, cacheWrite: 5 });

    expect(usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      contextTokens: 20_000,
      contextWindow: 200_000,
      percentage: 10,
    });
  });
});

describe('resolveOmpTurnTokens', () => {
  const first = { input: 1000, output: 250, cacheRead: 400, cacheWrite: 60 };
  const second = { input: 1030, output: 260, cacheRead: 400, cacheWrite: 60 };

  it('bills a fresh session and only the difference afterwards', () => {
    expect(resolveOmpTurnTokens({ adopted: false, current: first, previous: null })).toEqual(first);
    expect(resolveOmpTurnTokens({ adopted: false, current: second, previous: first }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('treats a resumed session opening read as a baseline, not as consumption', () => {
    expect(resolveOmpTurnTokens({ adopted: true, current: first, previous: null }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(resolveOmpTurnTokens({ adopted: true, current: second, previous: first }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('leaves callers on their previous behaviour when the payload carries no counters', () => {
    expect(resolveOmpTurnTokens({ adopted: false, current: null, previous: first })).toBeUndefined();
  });
});
