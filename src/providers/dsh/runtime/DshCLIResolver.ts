import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getDshProviderSettings } from '../settings';

export class DshCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'dsh',
    getSettingsProjection: (settings) => {
      const providerSettings = getDshProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'dsh'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'dsh',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
