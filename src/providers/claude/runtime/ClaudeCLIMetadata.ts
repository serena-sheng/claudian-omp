import type { CLIProviderMetadata } from '../../../core/providers/cli/CLIProviderMetadata';

/**
 * CLI lifecycle metadata for the Claude Code CLI.
 *
 * Readiness only *displays* the install/update commands; Claudian never runs
 * them on the user's behalf (see Obsidian's dependency-installation policy).
 */
export const CLAUDE_CLI_METADATA: CLIProviderMetadata = {
  binaryName: 'claude',
  displayName: 'Claude Code',
  npmPackage: '@anthropic-ai/claude-code',
  installerUrl: 'https://github.com/anthropics/claude-code',
};
