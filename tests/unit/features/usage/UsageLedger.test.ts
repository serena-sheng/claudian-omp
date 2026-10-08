import { USAGE_LOG_PATH, UsageLedger, type UsageLedgerStorage } from '@/features/usage/UsageLedger';

/** In-memory stand-in for the vault adapter the ledger writes through. */
function memoryStorage(initial: Record<string, string> = {}): UsageLedgerStorage & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: async (path) => files.has(path),
    read: async (path) => files.get(path) ?? '',
    write: async (path, content) => { files.set(path, content); },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(offsetDays: number): string {
  const date = new Date(Date.now() - offsetDays * DAY_MS);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const baseRecord = {
  conversationId: 'conv-1',
  providerId: 'omp',
  inputTokens: 100,
  outputTokens: 40,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
};

it('accumulates per-day and per-session totals from recorded events', async () => {
  const ledger = await UsageLedger.load(memoryStorage());

  ledger.record(baseRecord);
  ledger.record({ ...baseRecord, conversationId: 'conv-2', inputTokens: 7, outputTokens: 3 });
  ledger.record({ ...baseRecord, inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, ts: Date.now() - DAY_MS });

  const today = ledger.getToday();
  expect(today.inputTokens).toBe(107);
  expect(today.outputTokens).toBe(43);
  expect(today.cacheReadInputTokens).toBe(20);
  expect(today.cacheCreationInputTokens).toBe(10);
  expect(today.totalTokens).toBe(180);

  expect(ledger.getDaily(7).map(entry => entry.day)).toEqual([dayKey(0), dayKey(1)]);

  expect(ledger.getSessionTotals('conv-2')).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  expect(ledger.getSessionTotals('missing')).toBeNull();

  expect(ledger.getTopSessions(10).map(session => session.conversationId)).toEqual(['conv-1', 'conv-2']);
});

it('round-trips through the log file, so a fresh ledger sees earlier totals', async () => {
  const storage = memoryStorage();
  const first = await UsageLedger.load(storage);
  first.record(baseRecord);
  await first.flushWritesForTests();

  const second = await UsageLedger.load(storage);

  expect(second.getToday().inputTokens).toBe(100);
  expect(second.getSessionTotals('conv-1')).toMatchObject({ outputTokens: 40, totalTokens: 155 });
});

it('drops entries past retention on load and rewrites the log without them', async () => {
  const storage = memoryStorage();
  const seeded = await UsageLedger.load(storage);
  seeded.record({ ...baseRecord, ts: Date.now() - 200 * DAY_MS });
  seeded.record({ ...baseRecord, inputTokens: 12 });
  await seeded.flushWritesForTests();

  const reloaded = await UsageLedger.load(storage);
  await reloaded.flushWritesForTests();

  const keptLines = (storage.files.get(USAGE_LOG_PATH) ?? '').trim().split('\n').filter(Boolean);
  expect(keptLines).toHaveLength(1);
  expect(reloaded.getToday().inputTokens).toBe(12);
  expect(reloaded.getDaily(7)).toHaveLength(1);
});

it('ignores unparseable lines instead of failing the load', async () => {
  const storage = memoryStorage({
    [USAGE_LOG_PATH]: `not json\n${JSON.stringify({ ...baseRecord, ts: Date.now(), day: dayKey(0) })}\n{"ts":"nope"}\n`,
  });

  const ledger = await UsageLedger.load(storage);

  expect(ledger.getToday().inputTokens).toBe(100);
});

it('never throws when the storage read or write rejects', async () => {
  const failing: UsageLedgerStorage = {
    exists: async () => { throw new Error('nope'); },
    read: async () => { throw new Error('nope'); },
    write: async () => { throw new Error('nope'); },
  };

  const ledger = await UsageLedger.load(failing);
  expect(() => ledger.record(baseRecord)).not.toThrow();
  await expect(ledger.flushWritesForTests()).resolves.toBeUndefined();
});
