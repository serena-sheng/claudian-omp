import * as fs from 'node:fs';
import * as path from 'node:path';

import { Setting } from 'obsidian';

import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import { DSH_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderSettingsTabRenderer
} from '../../../core/providers/types';
import type { ClaudianSettings } from '../../../core/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import type { DshWorkspaceServices } from '../app/DshWorkspaceServices';
import {
  getDshProviderSettings,
  updateDshProviderSettings
} from '../settings';

const DSH_PROVIDER_ID = 'dsh' as const;

export const dshSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = context.plugin.storage.installationKey;
    const workspace = getDshWorkspaceServices();

    const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
      getValue: () => getDshProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'DeepSeek Harness' }),
      onChange: async (enabled) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          DSH_PROVIDER_ID,
          enabled,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(
          [DSH_PROVIDER_ID],
          async () => context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              DSH_PROVIDER_ID,
              enabled,
            );
          }),
        );
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged(DSH_PROVIDER_ID);
      },
    };

    const installationContainer = container.createDiv();
    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => {
        const current = getDshProviderSettings(settingsBag);
        return (current.visibleModels ?? current.currentCatalog?.models ?? []).length > 0;
      },
      getIsEnabled: () => getDshProviderSettings(settingsBag).enabled,
      providerId: DSH_PROVIDER_ID,
      providerName: 'DeepSeek Harness',
    });

    renderCLIInstallationSetting({
      cliName: 'DeepSeek Harness',
      icon: DSH_PROVIDER_ICON,
      inspect: async () => {
        const settings = context.plugin.settings as unknown as Record<string, unknown>;
        const config = getDshProviderSettings(settings);
        return probeCLIInstallation({
          path: await context.plugin.getResolvedProviderCliPath('dsh'),
          configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
          args: ['--version'],
          env: { ...process.env, ...getRuntimeEnvironmentVariables(settings, 'dsh') },
        });
      },
      container: installationContainer,
      enablement,
      getValue: () => {
        const current = getDshProviderSettings(settingsBag);
        return current.cliPathsByHost[hostnameKey] ?? current.cliPath ?? '';
      },
      name: t('settings.cliPath.genericName'),
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getDshProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }
        const mutation = (settings: ClaudianSettings): void => {
          updateDshProviderSettings(settings, {
            cliPath: '',
            cliPathsByHost,
          });
        };
        await context.plugin.applyProviderRuntimeSettings(
          [DSH_PROVIDER_ID],
          mutation,
          () => workspace.cliResolver.reset(),
        );
        modelWarning.context.notifyProviderModelOptionsChanged(DSH_PROVIDER_ID);
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\dsh.cmd'
        : '/usr/local/bin/dsh',
      validate: validateCLIPath,
    });
    new Setting(container).setDesc(t('settings.dsh.cliNote'));

    new Setting(container).setName('Models').setHeading();
    const modelPicker = renderProviderModelsSection(container, 'dsh', 'DeepSeek Harness', workspace.modelCatalog!, () => modelWarning.refresh());

    renderEnvironmentSettingsSection({
      container,
      desc: t('settings.dsh.environment.desc'),
      heading: t('settings.environment'),
      name: t('settings.dsh.environment.name'),
      placeholder: 'DEEPSEEK_API_KEY=sk-your-key\nDSH_HOME=/path/to/dsh-home',
      plugin: context.plugin,
      renderCustomContextLimits: target => context.renderCustomContextLimits(target, DSH_PROVIDER_ID),
      scope: 'provider:dsh',
    });
    return modelPicker;
  },
};

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!path.posix.isAbsolute(expandedPath) && !path.win32.isAbsolute(expandedPath)) {
    return t('settings.cliPath.validation.mustBeAbsolute');
  }
  try {
    if (!fs.existsSync(expandedPath)) {
      return t('settings.cliPath.validation.notExist');
    }
    if (!fs.statSync(expandedPath).isFile()) {
      return t('settings.cliPath.validation.notFile');
    }
    if (process.platform !== 'win32') {
      fs.accessSync(expandedPath, fs.constants.X_OK);
    }
  } catch {
    return process.platform === 'win32'
      ? t('settings.cliPath.validation.notAccessible')
      : t('settings.cliPath.validation.notExecutable');
  }
  return null;
}

function getDshWorkspaceServices(): DshWorkspaceServices {
  return ProviderWorkspaceRegistry.requireServices(DSH_PROVIDER_ID) as DshWorkspaceServices;
}
