import {
  buildPiUsageInfo,
  diffPiSessionTokenTotals,
  readPiSessionTokenTotals,
  resolvePiTurnTokens,
} from '@/providers/pi/runtime/buildPiUsageInfo';

describe('buildPiUsageInfo', () => {
  it('normalizes fractional provider percentages to whole context-meter percentages', () => {
    const usage = buildPiUsageInfo({
      contextUsage: {
        contextTokens: 24_691,
        contextWindow: 200_000,
        inputTokens: 1200,
        percentage: 0.123456789,
      },
    }, 'pi:openai/gpt-5');

    expect(usage?.percentage).toBe(12);
  });

  it('preserves provider percentages that are already whole percent values', () => {
    const usage = buildPiUsageInfo({
      context_usage: {
        context_tokens: 50_000,
        context_window: 200_000,
        input_tokens: 1200,
        percentage: 25,
      },
    }, null);

    expect(usage?.percentage).toBe(25);
  });

  it('rounds provider percentage decimals when they are already percent values', () => {
    const usage = buildPiUsageInfo({
      contextUsage: {
        contextTokens: 24_691,
        contextWindow: 200_000,
        inputTokens: 1200,
        percentage: 12.3456789,
      },
    }, null);

    expect(usage?.percentage).toBe(12);
  });

  it('rounds derived percentages to match the shared context meter contract', () => {
    const usage = buildPiUsageInfo({
      contextUsage: {
        contextTokens: 11_830,
        contextWindow: 200_000,
        inputTokens: 38,
      },
    }, null);

    expect(usage?.percentage).toBe(6);
  });

  it('uses discovered model metadata when stats omit the window', () => {
    const usage = buildPiUsageInfo({
      contextUsage: {
        contextTokens: 50_000,
        inputTokens: 1200,
      },
    }, 'pi:anthropic/claude-sonnet-4', 1_000_000);

    expect(usage).toMatchObject({
      contextWindow: 1_000_000,
      percentage: 5,
    });
  });

  it('reports an unknown window without stats or metadata', () => {
    const usage = buildPiUsageInfo({
      contextUsage: {
        contextTokens: 50_000,
        contextWindow: 0,
        inputTokens: 1200,
      },
    }, 'pi:anthropic/claude-sonnet-4');

    expect(usage).toMatchObject({ contextWindow: 0, percentage: 0 });
  });
});

describe('Pi turn token deltas', () => {
  const cumulative = { input: 1000, output: 250, cacheRead: 400, cacheWrite: 60 };

  it('reads the session-cumulative tokens block, tolerating snake_case keys', () => {
    expect(readPiSessionTokenTotals({ tokens: cumulative })).toEqual(cumulative);
    expect(readPiSessionTokenTotals({ tokens: { input: 5, output: 6, cache_read: 7, cache_write: 8 } }))
      .toEqual({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
    expect(readPiSessionTokenTotals({ contextUsage: { tokens: 10 } })).toBeNull();
  });

  it('counts the first read as the whole delta and later reads as the difference', () => {
    expect(diffPiSessionTokenTotals(null, cumulative)).toEqual(cumulative);
    expect(diffPiSessionTokenTotals(cumulative, { input: 1030, output: 260, cacheRead: 400, cacheWrite: 60 }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('clamps counter regressions to zero instead of reporting negative usage', () => {
    expect(diffPiSessionTokenTotals(cumulative, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('reports the delta on the usage event while keeping the context meter from contextUsage', () => {
    const usage = buildPiUsageInfo({
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

describe('resolvePiTurnTokens', () => {
  const first = { input: 1000, output: 250, cacheRead: 400, cacheWrite: 60 };
  const second = { input: 1030, output: 260, cacheRead: 400, cacheWrite: 60 };

  it('bills a fresh session and only the difference afterwards', () => {
    expect(resolvePiTurnTokens({ adopted: false, current: first, previous: null })).toEqual(first);
    expect(resolvePiTurnTokens({ adopted: false, current: second, previous: first }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('treats a resumed session opening read as a baseline, not as consumption', () => {
    expect(resolvePiTurnTokens({ adopted: true, current: first, previous: null }))
      .toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(resolvePiTurnTokens({ adopted: true, current: second, previous: first }))
      .toEqual({ input: 30, output: 10, cacheRead: 0, cacheWrite: 0 });
  });

  it('leaves callers on their previous behaviour when the payload carries no counters', () => {
    expect(resolvePiTurnTokens({ adopted: false, current: null, previous: first })).toBeUndefined();
  });
});
