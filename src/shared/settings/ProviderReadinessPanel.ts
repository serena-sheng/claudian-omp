/**
 * The per-provider readiness panel rendered at the top of each provider tab.
 *
 * It collects the real facts (enabled state, CLI probe, model catalog), renders
 * the resulting snapshot, and turns failed checks into actionable steps. Per
 * Obsidian's dependency-installation policy, install/update commands are only
 * ever *displayed* for the user to copy; the panel never executes them.
 *
 * The only network I/O is the optional latest-version lookup. It is off unless
 * the caller enables it (`checkForUpdates`); when disabled the panel neither
 * builds a fetch closure nor calls `fetchLatestCLIVersion`, so rendering and
 * refreshing perform no network access at all. When enabled, the registry is
 * contacted only after the user presses the "check for update" button.
 */

import type { CLIInstallation } from '../../core/providers/cli/CLIInstallationProbe';
import {
  type CLICommand,
  type CLIProviderMetadata,
  formatCLICommand,
  resolveCLIInstallCommand,
  resolveCLIInstallerUrl,
  resolveCLIUpdateCommand,
  resolveLatestVersionNpmPackage,
} from '../../core/providers/cli/CLIProviderMetadata';
import { fetchLatestCLIVersion, isUpdateAvailable } from '../../core/providers/cli/CLIVersionUtils';
import type { ProviderModelCatalog } from '../../core/providers/models/ProviderModelCatalog';
import type { ProviderReadinessCheck, ProviderReadinessCheckId, ProviderReadinessStatus } from '../../core/providers/ProviderReadiness';
import type { ProviderReadinessModelCounts, ProviderReadinessReport } from '../../core/providers/ProviderReadinessProbe';
import { probeProviderReadiness } from '../../core/providers/ProviderReadinessProbe';
import { t } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/types';

export interface ProviderReadinessPanelOptions {
  container: HTMLElement;
  metadata: CLIProviderMetadata;
  /** Provider name used inside remediation copy. */
  providerName: string;
  /** Reads whether the provider is turned on in settings. */
  enabled: () => boolean;
  /** Resolves the provider CLI and reads its version. */
  inspectCLI: () => Promise<CLIInstallation>;
  /** Source of the discovered/selected model counts. */
  modelCatalog?: Pick<ProviderModelCatalog, 'getSnapshot'>;
  /**
   * Whether to offer the npm-registry update check. Off by default so the panel
   * performs no network access. Pass the persisted setting's value; a getter is
   * accepted so a live settings change is honoured on the next refresh.
   */
  checkForUpdates?: boolean | (() => boolean);
}

export interface ProviderReadinessPanelControl {
  refresh: () => Promise<void>;
  dispose: () => void;
}

const STATUS_LABELS: Readonly<Record<ProviderReadinessStatus, TranslationKey>> = {
  attention: 'settings.readiness.status.attention',
  blocked: 'settings.readiness.status.blocked',
  disabled: 'settings.readiness.status.disabled',
  ready: 'settings.readiness.status.ready',
};

const CHECK_LABELS: Readonly<Record<ProviderReadinessCheckId, TranslationKey>> = {
  cli: 'settings.readiness.check.cli',
  enabled: 'settings.readiness.check.enabled',
  models: 'settings.readiness.check.models',
  selection: 'settings.readiness.check.selection',
};

export function renderProviderReadinessPanel(
  options: ProviderReadinessPanelOptions,
): ProviderReadinessPanelControl {
  const readModelCounts = (): ProviderReadinessModelCounts => {
    const snapshot = options.modelCatalog?.getSnapshot();
    return {
      discoveredModelCount: snapshot?.discoveredCount ?? 0,
      selectedModelCount: snapshot?.selectedIds.length ?? 0,
    };
  };
  const assess = (): Promise<ProviderReadinessReport> => probeProviderReadiness({
    enabled: options.enabled(),
    inspectCLI: options.inspectCLI,
    readModelCounts,
  });
  // Evaluated per refresh so a live settings value is honoured. When off, no
  // fetch closure is created and `fetchLatestCLIVersion` is never reached.
  const isUpdateCheckEnabled = (): boolean => {
    const value = options.checkForUpdates;
    return typeof value === 'function' ? value() : value === true;
  };

  const root = options.container.createDiv({ cls: 'claudian-provider-readiness' });
  const head = root.createDiv({ cls: 'claudian-provider-readiness-head' });
  head.createDiv({ cls: 'claudian-provider-readiness-title', text: t('settings.readiness.heading') });
  const badge = head.createSpan({
    cls: 'claudian-provider-readiness-badge',
    attr: { 'aria-live': 'polite', role: 'status' },
  });
  const refreshButton = head.createEl('button', {
    cls: 'claudian-provider-readiness-refresh',
    text: t('settings.readiness.refresh'),
    attr: { type: 'button' },
  });
  const list = root.createEl('ul', { cls: 'claudian-provider-readiness-checks' });
  const remedy = root.createDiv({ cls: 'claudian-provider-readiness-remedy' });

  let generation = 0;
  let disposed = false;

  const describeCheck = (check: ProviderReadinessCheck, report: ProviderReadinessReport): string => {
    const { input } = report;
    switch (check.id) {
      case 'enabled':
        return input.enabled
          ? t('settings.readiness.detail.enabled')
          : t('settings.readiness.detail.disabled');
      case 'cli':
        if (!input.cliPath) return t('settings.readiness.detail.cliMissing');
        return input.cliVersion
          ? t('settings.readiness.detail.cliFound', { path: input.cliPath, version: input.cliVersion })
          : t('settings.readiness.detail.cliNoVersion', { path: input.cliPath });
      case 'models':
        return input.discoveredModelCount > 0
          ? t('settings.readiness.detail.models', { count: input.discoveredModelCount })
          : t('settings.readiness.detail.modelsNone');
      case 'selection':
        return input.selectedModelCount > 0
          ? t('settings.readiness.detail.selection', { count: input.selectedModelCount })
          : t('settings.readiness.detail.selectionNone');
    }
  };

  const renderCommand = (container: HTMLElement, command: CLICommand): void => {
    const text = formatCLICommand(command);
    const row = container.createDiv({ cls: 'claudian-provider-readiness-command' });
    row.createEl('code', { text });
    const copyButton = row.createEl('button', {
      cls: 'claudian-provider-readiness-copy',
      text: t('settings.readiness.action.copy'),
      attr: { type: 'button' },
    });
    copyButton.addEventListener('click', () => {
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      void clipboard.writeText(text).then(
        () => {
          copyButton.setText(t('settings.readiness.action.copied'));
          window.setTimeout(() => copyButton.setText(t('settings.readiness.action.copy')), 2_000);
        },
        // The command stays selectable text, so a clipboard failure is not fatal.
        () => undefined,
      );
    });
  };

  const renderRemedy = (check: ProviderReadinessCheck, report: ProviderReadinessReport): void => {
    const row = remedy.createDiv({ cls: 'claudian-provider-readiness-step' });
    switch (check.remediation) {
      case 'enableProvider': {
        row.createSpan({ text: t('settings.readiness.remedy.enable', { provider: options.providerName }) });
        return;
      }
      case 'configureCli': {
        if (report.input.cliPath) {
          row.createSpan({ text: t('settings.readiness.remedy.cliUnreadable') });
          return;
        }
        row.createSpan({ text: t('settings.readiness.remedy.cliMissing', { name: options.metadata.displayName }) });
        const install = resolveCLIInstallCommand(options.metadata);
        if (install) renderCommand(row, install);
        const installerUrl = resolveCLIInstallerUrl(options.metadata);
        if (installerUrl) {
          row.createEl('a', { text: installerUrl, attr: { href: installerUrl, rel: 'noopener' } });
        }
        return;
      }
      case 'refreshModels': {
        row.createSpan({ text: t('settings.readiness.remedy.refreshModels') });
        return;
      }
      case 'selectModel': {
        row.createSpan({ text: t('settings.readiness.remedy.selectModel') });
        return;
      }
    }
  };

  const renderUpdateAction = (report: ProviderReadinessReport): void => {
    const currentVersion = report.input.cliVersion;
    if (!currentVersion || !isUpdateCheckEnabled()) return;
    const row = remedy.createDiv({ cls: 'claudian-provider-readiness-step claudian-provider-readiness-update' });
    const button = row.createEl('button', {
      cls: 'claudian-provider-readiness-check-update',
      text: t('settings.readiness.action.checkUpdate'),
      attr: { type: 'button' },
    });
    const result = row.createSpan({ cls: 'claudian-provider-readiness-update-result' });
    const requested = generation;
    button.addEventListener('click', () => {
      button.disabled = true;
      result.setText(t('settings.readiness.update.checking'));
      const packageName = resolveLatestVersionNpmPackage(options.metadata, currentVersion);
      const lookup = packageName
        ? fetchLatestCLIVersion(packageName)
        : Promise.resolve<string | null>(null);
      void lookup.then(
        (latest) => {
          if (disposed || requested !== generation) return;
          button.disabled = false;
          if (!latest) {
            result.setText(t('settings.readiness.update.unavailable'));
            return;
          }
          if (!isUpdateAvailable(currentVersion, latest)) {
            result.setText(t('settings.readiness.update.latest', { version: latest }));
            return;
          }
          result.setText(t('settings.readiness.update.available', { version: latest }));
          const update = resolveCLIUpdateCommand(options.metadata);
          if (update) renderCommand(row, update);
        },
        () => {
          if (disposed || requested !== generation) return;
          button.disabled = false;
          result.setText(t('settings.readiness.update.unavailable'));
        },
      );
    });
  };

  const renderReport = (report: ProviderReadinessReport): void => {
    root.dataset.state = report.snapshot.status;
    badge.setText(t(STATUS_LABELS[report.snapshot.status]));
    badge.dataset.state = report.snapshot.status;
    list.replaceChildren();
    remedy.replaceChildren();
    for (const check of report.snapshot.checks) {
      const item = list.createEl('li', { cls: 'claudian-provider-readiness-check' });
      item.dataset.state = check.status;
      item.createSpan({ cls: 'claudian-provider-readiness-check-label', text: t(CHECK_LABELS[check.id]) });
      item.createSpan({ cls: 'claudian-provider-readiness-check-detail', text: describeCheck(check, report) });
    }
    for (const check of report.snapshot.checks) {
      if (check.remediation) renderRemedy(check, report);
    }
    renderUpdateAction(report);
  };

  const refresh = async (): Promise<void> => {
    const requested = ++generation;
    refreshButton.disabled = true;
    root.dataset.state = 'checking';
    badge.removeAttribute('data-state');
    badge.setText(t('settings.readiness.checking'));
    list.replaceChildren();
    remedy.replaceChildren();
    const pending = list.createEl('li', { cls: 'claudian-provider-readiness-check', attr: { role: 'status' } });
    pending.createSpan({
      cls: 'claudian-provider-readiness-check-label',
      text: t('settings.readiness.checking'),
    });
    try {
      const report = await assess();
      if (disposed || requested !== generation) return;
      renderReport(report);
    } catch {
      if (disposed || requested !== generation) return;
      root.dataset.state = 'blocked';
      badge.dataset.state = 'blocked';
      badge.setText(t('settings.readiness.status.blocked'));
      list.replaceChildren();
      const failed = list.createEl('li', { cls: 'claudian-provider-readiness-check' });
      failed.createSpan({
        cls: 'claudian-provider-readiness-check-label',
        text: t('settings.readiness.checkFailed'),
      });
    } finally {
      if (!disposed && requested === generation) refreshButton.disabled = false;
    }
  };

  refreshButton.addEventListener('click', () => {
    void refresh();
  });
  void refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      generation += 1;
      root.remove();
    },
  };
}
