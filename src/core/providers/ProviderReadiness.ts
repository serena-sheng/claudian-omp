/**
 * Pure Readiness assessment for a provider.
 *
 * `assessProviderReadiness` takes already-resolved facts about a provider and
 * returns a status snapshot the settings UI renders. It performs no I/O; CLI
 * probing and model discovery happen in `ProviderReadinessProbe`.
 */

export type ProviderReadinessStatus = 'disabled' | 'blocked' | 'attention' | 'ready';

export type ProviderReadinessCheckId = 'enabled' | 'cli' | 'models' | 'selection';

export type ProviderReadinessRemediation =
  | 'enableProvider'
  | 'configureCli'
  | 'refreshModels'
  | 'selectModel';

/** Resolved facts about a provider, gathered by the probe layer. */
export interface ProviderReadinessInput {
  enabled: boolean;
  /** Resolved CLI path, or null when the binary cannot be located. */
  cliPath: string | null;
  /** Version reported by the CLI, or null when the probe failed. */
  cliVersion: string | null;
  /** Number of models the provider has discovered on this machine. */
  discoveredModelCount: number;
  /** Number of models the user has selected as usable. */
  selectedModelCount: number;
}

/** A single readiness check, with the actionable step that unblocks it. */
export interface ProviderReadinessCheck {
  id: ProviderReadinessCheckId;
  status: ProviderReadinessStatus;
  remediation?: ProviderReadinessRemediation;
  /** Human-relevant detail (e.g. the CLI version) for renderers. */
  detail?: string;
}

export interface ProviderReadinessSnapshot {
  status: ProviderReadinessStatus;
  checks: ProviderReadinessCheck[];
}

/**
 * Assess a provider's readiness across four checks:
 *
 * 1. enabled   — is the provider turned on?
 * 2. cli       — is the CLI resolvable and can it report a version?
 * 3. models    — has the provider pulled a non-empty model catalog?
 * 4. selection — has the user selected at least one usable model?
 *
 * The overall status is the worst of: `blocked` (a hard requirement is unmet),
 * `attention` (a soft requirement needs the user's eye), else `ready`.
 */
export function assessProviderReadiness(input: ProviderReadinessInput): ProviderReadinessSnapshot {
  if (!input.enabled) {
    return {
      status: 'disabled',
      checks: [
        { id: 'enabled', status: 'disabled', remediation: 'enableProvider' },
        { id: 'cli', status: 'disabled' },
        { id: 'models', status: 'disabled' },
        { id: 'selection', status: 'disabled' },
      ],
    };
  }

  const cliStatus: ProviderReadinessStatus = input.cliPath
    ? (input.cliVersion ? 'ready' : 'blocked')
    : 'blocked';
  const modelsStatus: ProviderReadinessStatus = input.discoveredModelCount > 0
    ? 'ready'
    : 'attention';
  const selectionStatus: ProviderReadinessStatus = input.selectedModelCount > 0
    ? 'ready'
    : 'blocked';

  const checks: ProviderReadinessCheck[] = [
    { id: 'enabled', status: 'ready' },
    {
      id: 'cli',
      status: cliStatus,
      detail: input.cliVersion ?? undefined,
      ...(cliStatus === 'blocked' ? { remediation: 'configureCli' as const } : {}),
    },
    {
      id: 'models',
      status: modelsStatus,
      ...(modelsStatus === 'attention' ? { remediation: 'refreshModels' as const } : {}),
    },
    {
      id: 'selection',
      status: selectionStatus,
      ...(selectionStatus === 'blocked' ? { remediation: 'selectModel' as const } : {}),
    },
  ];

  return {
    status: checks.some(check => check.status === 'blocked')
      ? 'blocked'
      : checks.some(check => check.status === 'attention')
        ? 'attention'
        : 'ready',
    checks,
  };
}
