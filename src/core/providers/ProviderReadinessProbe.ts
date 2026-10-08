/**
 * Gathers the real facts behind a readiness snapshot.
 *
 * Callers wire the provider-specific sources (its settings, its CLI resolver,
 * its model catalog); this module only sequences them and hands the collected
 * input to the pure `assessProviderReadiness`.
 */

import type { CLIInstallation } from './cli/CLIInstallationProbe';
import { assessProviderReadiness, type ProviderReadinessInput, type ProviderReadinessSnapshot } from './ProviderReadiness';

/** Model catalog facts, normally read from `ProviderModelCatalog.getSnapshot()`. */
export interface ProviderReadinessModelCounts {
  discoveredModelCount: number;
  selectedModelCount: number;
}

export interface ProviderReadinessProbeOptions {
  /** Whether the provider is turned on in settings. */
  enabled: boolean;
  /** Resolves the provider CLI and reads its version. */
  inspectCLI: () => Promise<CLIInstallation>;
  /** Reads the current model catalog. Omitted counts are treated as zero. */
  readModelCounts?: () => ProviderReadinessModelCounts;
}

export interface ProviderReadinessReport {
  snapshot: ProviderReadinessSnapshot;
  /** The resolved facts the snapshot was derived from, for renderers. */
  input: ProviderReadinessInput;
}

const EMPTY_COUNTS: ProviderReadinessModelCounts = {
  discoveredModelCount: 0,
  selectedModelCount: 0,
};

/**
 * Collect a provider's readiness.
 *
 * A disabled provider skips the CLI probe entirely: it just spawned a process
 * to read a version nobody needs while the provider is off, and
 * `assessProviderReadiness` reports every check as disabled anyway.
 */
export async function probeProviderReadiness(
  options: ProviderReadinessProbeOptions,
): Promise<ProviderReadinessReport> {
  const counts = options.readModelCounts?.() ?? EMPTY_COUNTS;
  const installation: CLIInstallation | null = options.enabled
    // A probe that throws means "unknown", not "ready".
    ? await options.inspectCLI().catch(() => null)
    : null;
  const input: ProviderReadinessInput = {
    enabled: options.enabled,
    cliPath: installation?.path ?? null,
    cliVersion: installation?.version ?? null,
    discoveredModelCount: counts.discoveredModelCount,
    selectedModelCount: counts.selectedModelCount,
  };
  return { input, snapshot: assessProviderReadiness(input) };
}
