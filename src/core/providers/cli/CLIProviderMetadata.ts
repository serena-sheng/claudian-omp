/**
 * Per-provider CLI metadata for version probing, install, and update.
 *
 * A provider that exposes a CLI registers one `CLIProviderMetadata` entry (see
 * `src/providers/<id>/runtime/<Id>CLIMetadata.ts`). Core tooling consumes this
 * information to probe the local version, resolve the latest release, and
 * render lifecycle commands for the user to run.
 *
 * Obsidian's developer policy forbids plugins from installing or updating
 * their own dependencies, so this module only *resolves and formats* commands;
 * nothing here (and nothing in the Readiness panel) ever executes them.
 */

/** A structured CLI command (safe to format for display or spawn via cross-spawn). */
export interface CLICommand {
  command: string;
  args: readonly string[];
}

/** Platform-specific lifecycle command overrides. */
export interface CLIPlatformOverrides {
  install?: CLICommand;
  update?: CLICommand;
  installerUrl?: string;
}

/**
 * Per-provider CLI metadata for version probing, install, and update.
 *
 * Fields are intentionally all-optional except `binaryName` and `displayName`
 * so a new provider can start with a minimal entry and grow it later.
 */
export interface CLIProviderMetadata {
  /** Binary name used for PATH lookup (e.g. "omp", "pi", "codex"). */
  binaryName: string;

  /** Human-readable display name for the CLI (e.g. "OMP", "Pi"). */
  displayName: string;

  /** npm package name used for registry latest-version checks and default installs. */
  npmPackage?: string;

  /** Registry packages used only for latest-version checks on specific installed majors. */
  latestVersionNpmPackagesByMajor?: Readonly<Record<number, string>>;

  /** Optional official installer URL (shown when no structured install command exists). */
  installerUrl?: string;

  /** Arguments passed to the binary to read its version. Defaults to `["--version"]`. */
  versionArgs?: readonly string[];

  /** Structured install command. Defaults to `npm install -g <npmPackage>@latest`. */
  install?: CLICommand;

  /** Structured update command. Defaults to `npm install -g <npmPackage>@latest`. */
  update?: CLICommand;

  /** Platform-specific overrides (applied before the generic fields). */
  platform?: Partial<Record<NodeJS.Platform, CLIPlatformOverrides>>;
}

/** Resolve the effective install command for a metadata entry on the current platform. */
export function resolveCLIInstallCommand(metadata: CLIProviderMetadata): CLICommand | null {
  const platformOverride = metadata.platform?.[process.platform];
  if (platformOverride?.install) {
    return platformOverride.install;
  }
  if (metadata.install) {
    return metadata.install;
  }
  if (metadata.npmPackage) {
    return { command: 'npm', args: ['install', '-g', `${metadata.npmPackage}@latest`] };
  }
  return null;
}

/** Resolve the effective update command for a metadata entry on the current platform. */
export function resolveCLIUpdateCommand(metadata: CLIProviderMetadata): CLICommand | null {
  const platformOverride = metadata.platform?.[process.platform];
  if (platformOverride?.update) {
    return platformOverride.update;
  }
  if (metadata.update) {
    return metadata.update;
  }
  if (metadata.npmPackage) {
    // `npm update -g <pkg>` can be a silent no-op; forcing `install …@latest`
    // is the reliable way to move to the newest release.
    return { command: 'npm', args: ['install', '-g', `${metadata.npmPackage}@latest`] };
  }
  return null;
}

/** Resolve the effective installer URL for a metadata entry on the current platform. */
export function resolveCLIInstallerUrl(metadata: CLIProviderMetadata): string | null {
  const platformOverride = metadata.platform?.[process.platform];
  if (platformOverride?.installerUrl) {
    return platformOverride.installerUrl;
  }
  return metadata.installerUrl ?? null;
}

/**
 * Resolve the npm package to query for the latest version of an installed CLI.
 *
 * Falls back from a major-specific package (e.g. OpenCode v2 is distributed as
 * `@opencode/cli`) to the generic `npmPackage`.
 */
export function resolveLatestVersionNpmPackage(
  metadata: CLIProviderMetadata,
  version: string | null | undefined,
): string | undefined {
  const major = version?.match(/^(\d+)\./u)?.[1];
  return (major ? metadata.latestVersionNpmPackagesByMajor?.[Number(major)] : undefined)
    ?? metadata.npmPackage;
}

function quoteShellArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/u.test(argument)) {
    return argument;
  }
  return `'${argument.replace(/'/gu, `'\\''`)}'`;
}

/** Format a structured command into a single copyable shell string (display only). */
export function formatCLICommand(command: CLICommand): string {
  return [command.command, ...command.args].map(quoteShellArgument).join(' ');
}
