import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for the OpenAI Codex CLI.
 *
 * Windows installs may also come from the native release archive, which
 * `CodexBinaryLocator` resolves through `CODEX_INSTALL_DIR`; the npm command
 * below is the cross-platform path shown in the Readiness panel.
 */
export const CODEX_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'codex',
  displayName: 'Codex CLI',
  npmPackage: '@openai/codex',
  installerUrl: 'https://github.com/openai/codex',
};
