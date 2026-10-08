/** @jest-environment jsdom */

import '@/providers/index';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { renderProviderCapabilityMatrix } from '@/features/settings/ProviderCapabilityMatrix';

function cellFor(container: HTMLElement, providerName: string, columnIndex: number): HTMLElement {
  const rows = [...container.querySelectorAll('tbody tr')];
  const row = rows.find(candidate => candidate.querySelector('th')?.textContent === providerName);
  if (!row) throw new Error(`no row for ${providerName}`);
  const cells = [...row.querySelectorAll('td')];
  const cell = cells[columnIndex];
  if (!cell) throw new Error(`no cell ${columnIndex} in ${providerName}`);
  return cell as HTMLElement;
}

it('lists every registered provider, so a new one appears without editing the matrix', () => {
  const container = document.createElement('div');

  renderProviderCapabilityMatrix(container);

  const headers = [...container.querySelectorAll('thead th')].map(el => el.textContent);
  const rows = [...container.querySelectorAll('tbody tr')];
  expect(rows).toHaveLength(ProviderRegistry.getRegisteredProviderIds().length);
  expect(headers.length).toBeGreaterThan(1);
});

it('reads each value from the provider capabilities, not from a table of its own', () => {
  const container = document.createElement('div');

  renderProviderCapabilityMatrix(container);

  // Column 0 is image attachments. These two providers declare opposite values,
  // so whichever way the matrix is fed the cells must disagree.
  const withImages = cellFor(container, 'Claude Code', 0);
  const withoutImages = cellFor(container, 'DeepSeek Harness', 0);

  expect(withImages.classList.contains('is-supported')).toBe(true);
  expect(withoutImages.classList.contains('is-unsupported')).toBe(true);
  expect(withoutImages.textContent).not.toBe(withImages.textContent);
});

it('labels an unsupported cell for assistive technology', () => {
  const container = document.createElement('div');

  renderProviderCapabilityMatrix(container);

  const unsupported = container.querySelector('.claudian-capability-matrix-cell.is-unsupported');
  expect(unsupported?.getAttribute('aria-label')).toBeTruthy();
});
