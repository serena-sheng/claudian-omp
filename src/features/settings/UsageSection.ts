import { getUsageLedger, type UsageLedger } from '@/features/usage/UsageLedger';
import { t } from '@/i18n/i18n';

export interface UsageSectionOptions {
  /** Defaults to the module singleton; injectable for tests. */
  ledger?: UsageLedger | null;
  /** Resolves a conversation title; the raw id is shown when it cannot. */
  resolveConversationTitle?: (conversationId: string) => string | undefined;
}

const DAILY_ROWS = 7;
const SESSION_ROWS = 10;

function formatCount(value: number): string {
  return value.toLocaleString();
}

function appendRow(body: HTMLElement, cells: string[]): void {
  const row = body.createEl('tr');
  for (const cell of cells) {
    row.createEl('td', { text: cell });
  }
}

/**
 * Read-only token metering for the General tab. Reads the ledger at render
 * time; there is no live subscription, the numbers refresh on the next visit.
 */
export function renderUsageSection(container: HTMLElement, options: UsageSectionOptions = {}): void {
  const ledger = options.ledger !== undefined ? options.ledger : getUsageLedger();
  const root = container.createDiv({ cls: 'claudian-usage-section' });
  root.createEl('p', {
    cls: 'claudian-usage-note',
    text: t('settings.usage.note'),
  });
  if (!ledger) {
    root.createEl('p', { cls: 'claudian-usage-empty', text: t('settings.usage.empty') });
    return;
  }

  const today = ledger.getToday();
  const daily = ledger.getDaily(DAILY_ROWS);
  const sessions = ledger.getTopSessions(SESSION_ROWS);
  if (daily.length === 0 && sessions.length === 0) {
    root.createEl('p', { cls: 'claudian-usage-empty', text: t('settings.usage.empty') });
    return;
  }

  const todayEl = root.createDiv({ cls: 'claudian-usage-today' });
  todayEl.createEl('strong', { text: t('settings.usage.today') });
  todayEl.createSpan({
    text: ` — ${t('settings.usage.total')} ${formatCount(today.totalTokens)}`
      + ` · ${t('settings.usage.input')} ${formatCount(today.inputTokens)}`
      + ` · ${t('settings.usage.output')} ${formatCount(today.outputTokens)}`
      + ` · ${t('settings.usage.cache')} ${formatCount(today.cacheReadInputTokens + today.cacheCreationInputTokens)}`,
  });

  if (daily.length > 0) {
    root.createEl('h4', { text: t('settings.usage.last7days') });
    const table = root.createEl('table', { cls: 'claudian-usage-daily' });
    const head = table.createEl('thead').createEl('tr');
    head.createEl('th', { text: t('settings.usage.date') });
    head.createEl('th', { text: t('settings.usage.total') });
    head.createEl('th', { text: t('settings.usage.input') });
    head.createEl('th', { text: t('settings.usage.output') });
    const body = table.createEl('tbody');
    for (const day of daily) {
      appendRow(body, [
        day.day,
        formatCount(day.totalTokens),
        formatCount(day.inputTokens),
        formatCount(day.outputTokens),
      ]);
    }
  }

  if (sessions.length > 0) {
    const table = root.createEl('table', { cls: 'claudian-usage-sessions' });
    const head = table.createEl('thead').createEl('tr');
    head.createEl('th', { text: t('settings.usage.sessions') });
    head.createEl('th', { text: t('settings.usage.total') });
    const body = table.createEl('tbody');
    for (const session of sessions) {
      appendRow(body, [
        options.resolveConversationTitle?.(session.conversationId) ?? session.conversationId,
        formatCount(session.totalTokens),
      ]);
    }
  }
}
