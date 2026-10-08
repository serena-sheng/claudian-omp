import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for OMP (Oh My Pi).
 *
 * `OmpSubprocess` verifies this package name before treating a resolved binary
 * as an OMP installation, so the npm package here must stay in sync with it.
 */
export const OMP_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'omp',
  displayName: 'OMP',
  npmPackage: '@oh-my-pi/pi-coding-agent',
};
