import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/** CLI lifecycle metadata for the xAI Grok Build CLI (`grok agent`). */
export const GROK_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'grok',
  displayName: 'Grok Build',
  npmPackage: '@xai-official/grok',
  installerUrl: 'https://x.ai/cli',
};
