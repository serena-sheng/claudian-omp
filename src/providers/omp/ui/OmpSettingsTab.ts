import * as fs from 'node:fs';

import { Setting } from 'obsidian';

import { normalizeConfiguredCLIPath } from '@/core/process/cliPath';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getRuntimeEnvironmentVariables } from '@/core/providers/providerEnvironment';
import type { ProviderCLIResolver } from '@/core/providers/types';
import { OMP_PROVIDER_ICON } from '@/shared/icons';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';

import type { ProviderModelCatalog } from '../../../core/providers/models/ProviderModelCatalog';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import type { ProviderEnablementSettingOptions } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderModelsSection } from '../../../shared/settings/ProviderModelsSection';
import { buildOmpEnvironment } from '../runtime/OmpLaunchSpecBuilder';
import { resolveOmpProcessSpec } from '../runtime/OmpSubprocess';
import {
  getOmpProviderSettings,
  updateOmpProviderSettings
} from '../settings';

export function createOmpSettingsTabRenderer(
  workspace: { cliResolver: Pick<ProviderCLIResolver, 'reset'>; modelCatalog: ProviderModelCatalog; },
): ProviderSettingsTabRenderer {
  return {
    render(container, context) {
      const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
      const hostnameKey = context.plugin.storage.installationKey;

      const enablement: Omit<ProviderEnablementSettingOptions, 'container' | 'description'> = {
        getValue: () => getOmpProviderSettings(settingsBag).enabled,
        name: t('settings.providerEnablement.name', { provider: 'OMP' }),
        onChange: async (value) => {
          if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
            settingsBag,
            'omp',
            value,
          )) {
            lastProviderWarning.showFor();
            return;
          }

          let accepted = true;
          await context.plugin.runProviderExecutionTransition(['omp'], async () => {
            await context.plugin.mutateSettings((settings) => {
              accepted = ProviderSettingsCoordinator.applyProviderEnablement(
                settings,
                'omp',
                value,
              );
            });
          });
          if (accepted) {
            lastProviderWarning.hide();
          } else {
            lastProviderWarning.showFor();
          }
          modelWarning.context.notifyProviderModelOptionsChanged('omp');
        },
      };

      const installationContainer = container.createDiv();
      const lastProviderWarning = renderLastEnabledProviderWarning(container);

      const modelWarning = renderProviderModelEnablementWarning(container, context, {
        getHasEnabledModels: () => getOmpProviderSettings(settingsBag).visibleModels.length > 0,
        getIsEnabled: () => getOmpProviderSettings(settingsBag).enabled,
        providerId: 'omp',
        providerName: 'OMP',
      });

      renderCLIInstallationSetting({
        cliName: 'OMP',
        icon: OMP_PROVIDER_ICON,
        inspect: async () => {
          const settings = context.plugin.settings as unknown as Record<string, unknown>;
          const config = getOmpProviderSettings(settings);
          return probeCLIInstallation({
            path: await context.plugin.getResolvedProviderCliPath('omp'),
            configuredPath: config.cliPathsByHost[hostnameKey] || config.cliPath,
            args: ['--version'],
            env: buildOmpEnvironment(process.env, getRuntimeEnvironmentVariables(settings, 'omp')),
            prepareLaunch: (spec) => ({ ...spec, ...resolveOmpProcessSpec(spec, spec.env.PATH ?? '') }),
          });
        },
        container: installationContainer,
        enablement,
        getValue: () => {
          const config = getOmpProviderSettings(settingsBag);
          return config.cliPathsByHost[hostnameKey] || config.cliPath;
        },
        name: t('settings.cliPath.genericName'),
        onChange: async (value) => {
          const cliPathsByHost = {
            ...getOmpProviderSettings(settingsBag).cliPathsByHost,
          };
          if (value) {
            cliPathsByHost[hostnameKey] = value;
          } else {
            delete cliPathsByHost[hostnameKey];
          }

          await context.plugin.applyProviderRuntimeSettings(
            ['omp'],
            (settings) => {
              updateOmpProviderSettings(settings, {
                cliPathsByHost,
              });
            },
            () => workspace?.cliResolver?.reset(),
          );
          context.notifyProviderModelOptionsChanged('omp');
        },
        placeholder: process.platform === 'win32'
          ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\omp.cmd'
          : '/usr/local/bin/omp',
        validate: validateCLIPath,
      });

      new Setting(container).setName('Models').setHeading();
      const modelPicker = renderProviderModelsSection(container, 'omp', 'OMP', workspace.modelCatalog, () => modelWarning.refresh());

      renderEnvironmentSettingsSection({
        container,
        desc: t('settings.omp.environment.desc'),
        heading: t('settings.environment'),
        name: t('settings.omp.environment.name'),
        placeholder: 'OMP_SESSION_DIR=/path/to/sessions',
        plugin: context.plugin,
        scope: 'provider:omp',
      });
      return modelPicker;
    },
  };
}

function validateCLIPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = normalizeConfiguredCLIPath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return t('settings.cliPath.validation.notExist');
  }

  if (!fs.statSync(expandedPath).isFile()) {
    return t('settings.cliPath.validation.notFile');
  }

  return null;
}
