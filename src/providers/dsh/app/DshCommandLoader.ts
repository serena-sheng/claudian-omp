import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader as ProviderCommandLoaderContract,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';

import { getDshProviderSettings } from '../settings';
import type { DshCommandMetadataProbe } from './DshCommandMetadataProbe';

export class DshCommandLoader implements ProviderCommandLoaderContract {
  constructor(private readonly metadataProbe: DshCommandMetadataProbe) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const providerSettings = getDshProviderSettings(settings);
    const hasConfiguredCli = providerSettings.cliPath.length > 0
      || Object.values(providerSettings.cliPathsByHost).some(path => path.trim().length > 0);
    return [
      'dsh:commands:v2',
      providerSettings.enabled ? 'enabled' : 'disabled',
      hasConfiguredCli ? 'configured-cli' : 'auto-cli',
    ].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getDshProviderSettings(settings).enabled;
  }

  async loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: signal => this.metadataProbe.load(signal),
      errorMessage: 'Could not load DeepSeek Harness skills and commands.',
      projectItems: commands => commands,
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: 'DeepSeek Harness command metadata has not been loaded for this tab.',
      signal: context.signal,
    });
  }
}
