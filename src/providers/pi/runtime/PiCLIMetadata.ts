import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for the Pi coding agent.
 *
 * `PiSubprocess` verifies this package name before treating a resolved binary
 * as a Pi installation, so the npm package here must stay in sync with it.
 */
export const PI_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'pi',
  displayName: 'Pi',
  npmPackage: '@earendil-works/pi-coding-agent',
};
