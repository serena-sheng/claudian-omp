import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for OpenCode.
 *
 * OpenCode v2 ships from a different npm package than v1, so latest-version
 * checks key off the installed major (see `resolveLatestVersionNpmPackage`).
 */
export const OPENCODE_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'opencode',
  displayName: 'OpenCode',
  npmPackage: 'opencode-ai',
  latestVersionNpmPackagesByMajor: {
    2: '@opencode/cli',
  },
  installerUrl: 'https://opencode.ai/install',
};
