import { CachedProviderCLIResolver } from '../../../core/providers/cli/CachedProviderCLIResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getOmpProviderSettings } from '../settings';

export class OmpCLIResolver {
  private readonly resolver = new CachedProviderCLIResolver({
    binaryName: 'omp',
    getSettingsProjection: (settings) => {
      const providerSettings = getOmpProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'omp'),
        legacyCliPath: providerSettings.cliPath,
      };
    },
    providerId: 'omp',
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  reset(): void {
    this.resolver.reset();
  }
}
