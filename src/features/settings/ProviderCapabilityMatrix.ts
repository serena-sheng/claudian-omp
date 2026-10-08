import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderCapabilities } from '@/core/providers/types';
import { t } from '@/i18n/i18n';

/**
 * One column of the capability matrix. The *values* always come from the live
 * `ProviderCapabilities` the provider registered — never from a table written
 * here — so the matrix cannot drift away from what the code actually does. Only
 * the set of questions worth showing, and their labels, are declared.
 */
/** Literal union so the column label can be built as a checked translation key. */
type CapabilityColumnId =
  | 'imageAttachments'
  | 'fork'
  | 'rewind'
  | 'turnSteer'
  | 'planMode'
  | 'instructionMode'
  | 'providerCommands'
  | 'reasoningControl';

interface CapabilityColumn {
  id: CapabilityColumnId;
  /** Cell text; null renders as "not supported". */
  read: (capabilities: ProviderCapabilities) => string | null;
}

const SUPPORTED = '\u2713';
const UNSUPPORTED = '\u2014';

function flag(value: boolean | undefined): string | null {
  return value === true ? SUPPORTED : null;
}

const CAPABILITY_COLUMNS: readonly CapabilityColumn[] = [
  { id: 'imageAttachments', read: (c) => flag(c.supportsImageAttachments) },
  { id: 'fork', read: (c) => flag(c.supportsFork) },
  { id: 'rewind', read: (c) => flag(c.supportsRewind) },
  { id: 'turnSteer', read: (c) => flag(c.supportsTurnSteer) },
  { id: 'planMode', read: (c) => flag(c.supportsPlanMode) },
  { id: 'instructionMode', read: (c) => flag(c.supportsInstructionMode) },
  { id: 'providerCommands', read: (c) => flag(c.supportsProviderCommands) },
  {
    id: 'reasoningControl',
    read: (c) => t(c.reasoningControl === 'effort'
      ? 'settings.capabilityMatrix.reasoningEffort'
      : 'settings.capabilityMatrix.reasoningNone'),
  },
];

/**
 * Renders which agent harness can do what, read straight off the registered
 * providers. Providers are enumerated at render time, so a new provider shows
 * up here without touching this file.
 */
export function renderProviderCapabilityMatrix(container: HTMLElement): void {
  const providerIds = ProviderRegistry.getRegisteredProviderIds();
  if (providerIds.length === 0) {
    return;
  }

  container.createEl('p', {
    cls: 'claudian-capability-matrix-desc',
    text: t('settings.capabilityMatrix.desc'),
  });

  const table = container.createEl('table', { cls: 'claudian-capability-matrix' });
  const head = table.createEl('thead').createEl('tr');
  head.createEl('th', { text: t('settings.capabilityMatrix.providerColumn') });
  for (const column of CAPABILITY_COLUMNS) {
    head.createEl('th', { text: t(`settings.capabilityMatrix.columns.${column.id}`) });
  }

  const body = table.createEl('tbody');
  for (const providerId of providerIds) {
    const capabilities = ProviderRegistry.getCapabilities(providerId);
    const row = body.createEl('tr');
    row.createEl('th', {
      cls: 'claudian-capability-matrix-provider',
      text: ProviderRegistry.getProviderDisplayName(providerId),
    });
    for (const column of CAPABILITY_COLUMNS) {
      const value = column.read(capabilities);
      const cell = row.createEl('td', {
        cls: value === null
          ? 'claudian-capability-matrix-cell is-unsupported'
          : 'claudian-capability-matrix-cell is-supported',
        text: value ?? UNSUPPORTED,
      });
      if (value === null) {
        cell.setAttribute('aria-label', t('settings.capabilityMatrix.unsupported'));
      }
    }
  }
}
