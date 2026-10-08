/** @jest-environment jsdom */

import { renderUsageSection } from '@/features/settings/UsageSection';
import { UsageLedger, type UsageLedgerStorage } from '@/features/usage/UsageLedger';
import { t } from '@/i18n/i18n';

function memoryStorage(): UsageLedgerStorage {
  const files = new Map<string, string>();
  return {
    exists: async (path) => files.has(path),
    read: async (path) => files.get(path) ?? '',
    write: async (path, content) => { files.set(path, content); },
  };
}

async function ledgerWith(entries: Array<{ conversationId: string; inputTokens: number; outputTokens: number; ts?: number }>): Promise<UsageLedger> {
  const ledger = await UsageLedger.load(memoryStorage());
  for (const entry of entries) {
    ledger.record({
      conversationId: entry.conversationId,
      providerId: 'omp',
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      ...(entry.ts === undefined ? {} : { ts: entry.ts }),
    });
  }
  return ledger;
}

it('shows the day total for what has been recorded', async () => {
  const container = document.createElement('div');
  const ledger = await ledgerWith([
    { conversationId: 'conv-1', inputTokens: 1000, outputTokens: 250 },
    { conversationId: 'conv-1', inputTokens: 500, outputTokens: 125 },
  ]);

  renderUsageSection(container, { ledger, resolveConversationTitle: () => 'My session' });

  expect(container.textContent).toContain((1875).toLocaleString());
  expect(container.textContent).toContain(t('settings.usage.today'));
});

it('lists sessions by consumption and prefers a resolved title', async () => {
  const container = document.createElement('div');
  const ledger = await ledgerWith([
    { conversationId: 'small', inputTokens: 10, outputTokens: 0 },
    { conversationId: 'big', inputTokens: 900, outputTokens: 100 },
  ]);

  renderUsageSection(container, { ledger, resolveConversationTitle: id => (id === 'big' ? 'The big one' : undefined) });

  expect(container.textContent).toContain('The big one');
  expect(container.textContent).toContain('small');
});

it('falls back to the id when a title cannot be resolved', async () => {
  const container = document.createElement('div');
  const ledger = await ledgerWith([{ conversationId: 'conv-x', inputTokens: 5, outputTokens: 1 }]);

  renderUsageSection(container, { ledger });

  expect(container.textContent).toContain('conv-x');
});

it('renders an empty state before anything has been recorded', async () => {
  const container = document.createElement('div');
  const ledger = await ledgerWith([]);

  renderUsageSection(container, { ledger });

  expect(container.textContent).toContain(t('settings.usage.empty'));
});

it('renders the unavailable state when the ledger is not ready', () => {
  const container = document.createElement('div');

  renderUsageSection(container, { ledger: null });

  expect(container.querySelector('.claudian-usage-section')).not.toBeNull();
});
