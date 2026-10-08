import * as path from 'node:path';

import { buildDshRuntimeEnv } from '@/providers/dsh/runtime/DshRuntimeEnvironment';

describe('buildDshRuntimeEnv', () => {
  it('merges process, shared, and provider scope with an enhanced provider PATH', () => {
    process.env.DSH_P1_PROCESS_ONLY = 'from-process';
    const env = buildDshRuntimeEnv({
      providerConfigs: {
        dsh: {
          environmentVariables: [
            'PATH=/provider/bin',
            'CUSTOM_API_KEY=provider-secret',
          ].join('\n'),
        },
      },
      sharedEnvironmentVariables: 'HTTPS_PROXY=https://proxy.example.com',
    }, process.execPath);
    delete process.env.DSH_P1_PROCESS_ONLY;

    expect(env.DSH_P1_PROCESS_ONLY).toBe('from-process');
    expect(env.HTTPS_PROXY).toBe('https://proxy.example.com');
    expect(env.CUSTOM_API_KEY).toBe('provider-secret');
    expect(env.PATH?.split(path.delimiter)).toContain('/provider/bin');
    expect(env.PATH?.split(path.delimiter)).toContain(path.dirname(process.execPath));
  });

  it('applies provider over shared over process precedence for duplicate keys', () => {
    process.env.DSH_PRECEDENCE = 'from-process';
    process.env.DSH_SHARED_PRECEDENCE = 'from-process';
    try {
      const env = buildDshRuntimeEnv({
        providerConfigs: {
          dsh: {
            environmentVariables: 'DSH_PRECEDENCE=from-provider',
          },
        },
        sharedEnvironmentVariables: [
          'DSH_PRECEDENCE=from-shared',
          'DSH_SHARED_PRECEDENCE=from-shared',
        ].join('\n'),
      }, process.execPath);

      expect(env.DSH_PRECEDENCE).toBe('from-provider');
      expect(env.DSH_SHARED_PRECEDENCE).toBe('from-shared');
    } finally {
      delete process.env.DSH_PRECEDENCE;
      delete process.env.DSH_SHARED_PRECEDENCE;
    }
  });

  it('does not source shell expressions or force Dsh config, auth, model, or telemetry', () => {
    const env = buildDshRuntimeEnv({
      providerConfigs: {
        dsh: {
          environmentVariables: 'DSH_HOME=$HOME/custom\nXAI_API_KEY=user-provided',
        },
      },
    }, 'dsh');

    expect(env.DSH_HOME).toBe('$HOME/custom');
    expect(env.XAI_API_KEY).toBe('user-provided');
    expect(env).not.toHaveProperty('DSH_DEFAULT_MODEL');
    expect(env).not.toHaveProperty('DSH_TELEMETRY_DISABLED');
    expect(env).not.toHaveProperty('DSH_CONFIG');
    expect(env).not.toHaveProperty('DSH_TOKEN');
  });
});
