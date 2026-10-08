import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for the DeepSeek Harness.
 *
 * `dsh` ships as a Node.js CLI (`@deepseek-ai/dsh`, currently a developer
 * preview), so installing or updating it means running the npm command the
 * readiness panel renders — the plugin never runs it.
 */
export const DSH_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'dsh',
  displayName: 'DeepSeek Harness',
  npmPackage: '@deepseek-ai/dsh',
  installerUrl: 'https://github.com/deepseek-ai/deepseek-harness',
};
