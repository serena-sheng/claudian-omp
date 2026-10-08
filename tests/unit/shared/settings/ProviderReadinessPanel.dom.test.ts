/** @jest-environment jsdom */

import { waitFor, within } from '@testing-library/dom';

import { fetchLatestCLIVersion } from '@/core/providers/cli/CLIVersionUtils';
import type { ProviderModelCatalog, ProviderModelCatalogSnapshot } from '@/core/providers/models/ProviderModelCatalog';
import { PI_CLI_METADATA } from '@/providers/pi/runtime/PiCLIMetadata';
import { renderProviderReadinessPanel } from '@/shared/settings/ProviderReadinessPanel';

jest.mock('@/core/providers/cli/CLIVersionUtils', () => ({
  ...jest.requireActual('@/core/providers/cli/CLIVersionUtils'),
  fetchLatestCLIVersion: jest.fn(async () => null),
}));

const fetchLatestVersionMock = fetchLatestCLIVersion as jest.MockedFunction<typeof fetchLatestCLIVersion>;

beforeEach(() => {
  fetchLatestVersionMock.mockClear();
});

const readyCLI = async () => ({ path: '/usr/local/bin/pi', version: '1.1.0', source: 'auto' as const });

function catalog(discoveredCount: number, selectedIds: string[]): Pick<ProviderModelCatalog, 'getSnapshot'> {
  return {
    getSnapshot: () => ({ discoveredCount, selectedIds } as ProviderModelCatalogSnapshot),
  };
}

it('renders a ready provider with its CLI version and model counts', async () => {
  const container = document.createElement('div');

  const panel = renderProviderReadinessPanel({
    container,
    metadata: PI_CLI_METADATA,
    providerName: 'Pi',
    enabled: () => true,
    inspectCLI: async () => ({ path: '/usr/local/bin/pi', version: '1.1.0', source: 'auto' }),
    modelCatalog: catalog(11, ['a', 'b']),
  });

  await waitFor(() => expect(container.querySelector('[data-state="ready"]')).toBeTruthy());
  expect(container.textContent).toContain('v1.1.0');
  expect(container.textContent).toContain('11 models discovered');
  expect(container.textContent).toContain('2 models enabled');
  expect(within(container).queryByText('Re-check')).toBeTruthy();
  panel.dispose();
});

it('shows the copyable install command when the CLI is missing', async () => {
  const container = document.createElement('div');

  const panel = renderProviderReadinessPanel({
    container,
    metadata: PI_CLI_METADATA,
    providerName: 'Pi',
    enabled: () => true,
    inspectCLI: async () => ({ path: null, version: null, source: 'auto' }),
    modelCatalog: catalog(0, []),
  });

  await waitFor(() => expect(container.textContent).toContain('Not found on PATH'));
  expect(container.textContent).toContain('npm install -g @earendil-works/pi-coding-agent@latest');
  expect(within(container).getByRole('button', { name: 'Copy' })).toBeTruthy();
  panel.dispose();
});

it('skips the CLI probe while the provider is disabled', async () => {
  const container = document.createElement('div');
  const inspectCLI = jest.fn(async () => ({ path: '/usr/local/bin/pi', version: '1.1.0', source: 'auto' as const }));

  const panel = renderProviderReadinessPanel({
    container,
    metadata: PI_CLI_METADATA,
    providerName: 'Pi',
    enabled: () => false,
    inspectCLI,
    modelCatalog: catalog(0, []),
  });

  await waitFor(() => expect(container.textContent).toContain('Turn on Pi to use it.'));
  expect(inspectCLI).not.toHaveBeenCalled();
  panel.dispose();
});

it('drops late probe results once the panel is disposed', async () => {
  const container = document.createElement('div');

  const panel = renderProviderReadinessPanel({
    container,
    metadata: PI_CLI_METADATA,
    providerName: 'Pi',
    enabled: () => true,
    // tsconfig lib predates Promise.withResolvers; this probe must never settle.
    inspectCLI: () => new Promise(() => undefined),
  });
  panel.dispose();

  expect(container.querySelector('.claudian-provider-readiness')).toBeNull();
});

it.each([
  { label: 'omitted', checkForUpdates: undefined },
  { label: 'explicitly disabled', checkForUpdates: false },
])(
  'never contacts the npm registry during render or refresh while the update check is $label',
  async ({ checkForUpdates }) => {
    const container = document.createElement('div');

    const panel = renderProviderReadinessPanel({
      container,
      metadata: PI_CLI_METADATA,
      providerName: 'Pi',
      enabled: () => true,
      inspectCLI: readyCLI,
      modelCatalog: catalog(11, ['a']),
      checkForUpdates,
    });

    await waitFor(() => expect(container.querySelector('[data-state="ready"]')).toBeTruthy());
    await panel.refresh();

    expect(container.querySelector('.claudian-provider-readiness-check-update')).toBeNull();
    expect(fetchLatestVersionMock).not.toHaveBeenCalled();
    panel.dispose();
  },
);

it('reads the setting live and only queries the registry after the user presses the button', async () => {
  const container = document.createElement('div');
  let enabledCheck = false;

  const panel = renderProviderReadinessPanel({
    container,
    metadata: PI_CLI_METADATA,
    providerName: 'Pi',
    enabled: () => true,
    inspectCLI: readyCLI,
    modelCatalog: catalog(11, ['a']),
    checkForUpdates: () => enabledCheck,
  });

  await waitFor(() => expect(container.querySelector('[data-state="ready"]')).toBeTruthy());
  await panel.refresh();
  expect(container.querySelector('.claudian-provider-readiness-check-update')).toBeNull();

  enabledCheck = true;
  await panel.refresh();

  const button = container.querySelector<HTMLButtonElement>('.claudian-provider-readiness-check-update');
  expect(button).not.toBeNull();
  // Enabling the setting alone still performs no lookup; only the button does.
  expect(fetchLatestVersionMock).not.toHaveBeenCalled();

  button!.click();
  await waitFor(() => expect(fetchLatestVersionMock).toHaveBeenCalledWith('@earendil-works/pi-coding-agent'));
  panel.dispose();
});
