import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';

export function buildDshRuntimeEnv(
  settings: Record<string, unknown>,
  cliPath: string,
): NodeJS.ProcessEnv {
  const environmentText = getRuntimeEnvironmentText(settings, 'dsh');
  const configuredEnvironment = parseEnvironmentVariables(environmentText);

  return {
    // User-configured values (e.g. DEEPSEEK_API_KEY, DSH_HOME) win over process.env.
    ...process.env,
    ...configuredEnvironment,
    PATH: getEnhancedPath(configuredEnvironment.PATH, cliPath || undefined),
  };
}
