import type { CLIProviderMetadata } from '../../core/providers/cli/CLIProviderMetadata';
import { CLAUDE_CLI_METADATA } from '../claude/runtime/ClaudeCLIMetadata';
import { CODEX_CLI_METADATA } from '../codex/runtime/CodexCLIMetadata';
import { DSH_CLI_METADATA } from '../dsh/runtime/DshCLIMetadata';
import { GROK_CLI_METADATA } from '../grok/runtime/GrokCLIMetadata';
import { OMP_CLI_METADATA } from '../omp/runtime/OmpCLIMetadata';
import { OPENCODE_CLI_METADATA } from '../opencode/runtime/OpencodeCLIMetadata';
import { PI_CLI_METADATA } from '../pi/runtime/PiCLIMetadata';

/**
 * Every built-in provider's CLI lifecycle metadata, keyed by provider id.
 *
 * A provider owns its entry in `src/providers/<id>/runtime/<Id>CLIMetadata.ts`;
 * this table only aggregates them so tests and future consumers (e.g. an
 * aggregate "CLI versions" overview) can enumerate every provider without
 * importing them one by one.
 *
 * Adding a provider (for example `dsh`):
 *   1. add `src/providers/<id>/runtime/<Id>CLIMetadata.ts` exporting its metadata;
 *   2. import it here and add a table entry;
 *   3. pass `CLI_PROVIDER_METADATA.<id>` to `renderProviderReadinessPanel` in the
 *      provider's `ui/<Id>SettingsTab.ts`.
 */
export const CLI_PROVIDER_METADATA = {
  claude: CLAUDE_CLI_METADATA,
  codex: CODEX_CLI_METADATA,
  dsh: DSH_CLI_METADATA,
  grok: GROK_CLI_METADATA,
  omp: OMP_CLI_METADATA,
  opencode: OPENCODE_CLI_METADATA,
  pi: PI_CLI_METADATA,
} as const satisfies Readonly<Record<string, CLIProviderMetadata>>;
