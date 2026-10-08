import type { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import crossSpawn from 'cross-spawn';

import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
} from '@/core/process/windowsCmdShim';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { ProviderTransitionOwnerContext } from '../../../core/providers/types';
import { getVaultPath } from '../../../utils/path';
import type { DshDiscoveredModel } from '../models';
import { getDshProviderSettings } from '../settings';
import { DshModelCatalogProbe, type DshModelCatalogProbeLike } from './DshModelCatalogProbe';
import { buildDshRuntimeEnv } from './DshRuntimeEnvironment';

const FINGERPRINT_VERSION = '1';
const MODEL_COMMAND_TIMEOUT_MS = 20_000;
const VERSION_COMMAND_TIMEOUT_MS = 5_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const spawn = crossSpawn as typeof nodeSpawn;

export interface DshCatalogCommandRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface DshCatalogCommandResult {
  exitCode: number | null;
  stdout: string;
  termination?: 'abort' | 'error' | 'output-limit' | 'timeout';
}

export interface DshCatalogCommandRunner {
  run(request: DshCatalogCommandRequest): Promise<DshCatalogCommandResult>;
}

export type DshModelCatalogDiscoveryResult =
  | {
    defaultModelId: string | null;
    diagnostics?: string;
    fingerprint: string;
    kind: 'completed';
    models: DshDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export interface DshModelDiscoveryServiceLike {
  discoverCatalog(
    signal?: AbortSignal,
    context?: ProviderTransitionOwnerContext,
  ): Promise<DshModelCatalogDiscoveryResult>;
}

export interface DshModelDiscoveryServiceOptions {
  modelCommandTimeoutMs?: number;
  probe?: DshModelCatalogProbeLike;
  runner?: DshCatalogCommandRunner;
  versionCommandTimeoutMs?: number;
}

export interface DshCatalogFingerprintInputs {
  command: string;
  environmentKeys: string[];
  version: string;
}

interface DshResolvedCatalogCommandContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  environmentKeys: string[];
}

export function buildDshCatalogFingerprint(inputs: DshCatalogFingerprintInputs): string {
  const payload = [
    FINGERPRINT_VERSION,
    inputs.command.trim(),
    inputs.version.trim(),
    Array.from(new Set(inputs.environmentKeys.map(key => key.trim()).filter(Boolean))).sort(),
  ];
  return `${FINGERPRINT_VERSION}:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`;
}


export class DshModelDiscoveryService implements DshModelDiscoveryServiceLike {
  private readonly runner: DshCatalogCommandRunner;
  private readonly probe: DshModelCatalogProbeLike;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: DshModelDiscoveryServiceOptions = {},
  ) {
    this.runner = options.runner ?? new SpawnDshCatalogCommandRunner();
    this.probe = options.probe ?? new DshModelCatalogProbe();
  }

  async discoverCatalog(
    signal?: AbortSignal,
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<DshModelCatalogDiscoveryResult> {
    if (!getDshProviderSettings(this.plugin.settings).enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    try {
      const context = await this.#resolveCommandContext(ownerContext);
      const fingerprint = await this.#resolveFingerprint(context, signal);
      try {
        const catalog = await this.probe.discover({
          command: context.command,
          cwd: context.cwd,
          env: context.env,
          signal,
          timeoutMs: this.options.modelCommandTimeoutMs ?? MODEL_COMMAND_TIMEOUT_MS,
          version: this.plugin.manifest?.version ?? '0.0.0',
        });
        return {
          defaultModelId: catalog.currentModelId,
          fingerprint,
          kind: 'completed',
          models: catalog.models,
        };
      } catch {
        // dsh publishes models only through the ACP session/new configOptions
        // snapshot; there is no standalone `dsh models` fallback to retry with.
        return {
          defaultModelId: null,
          diagnostics: signal?.aborted
            ? 'DeepSeek Harness model discovery was cancelled'
            : 'DeepSeek Harness ACP model discovery failed',
          fingerprint,
          kind: 'completed',
          models: [],
        };
      }
    } catch {
      return {
        defaultModelId: null,
        diagnostics: 'DeepSeek Harness model discovery could not be started',
        fingerprint: buildDshCatalogFingerprint({
          command: '',
          environmentKeys: [],
          version: 'unavailable',
        }),
        kind: 'completed',
        models: [],
      };
    }
  }

  async #resolveCommandContext(
    ownerContext?: ProviderTransitionOwnerContext,
  ): Promise<DshResolvedCatalogCommandContext> {
    const command = await this.plugin.getResolvedProviderCliPath(
      'dsh',
      ownerContext,
    ) ?? 'dsh';
    const configuredEnvironment = getRuntimeEnvironmentVariables(this.plugin.settings, 'dsh');
    return {
      command,
      cwd: getVaultPath(this.plugin.app) ?? process.cwd(),
      env: buildDshRuntimeEnv(this.plugin.settings, command),
      environmentKeys: Object.keys(configuredEnvironment),
    };
  }

  async #resolveFingerprint(
    context: DshResolvedCatalogCommandContext,
    signal?: AbortSignal,
  ): Promise<string> {
    let version = 'unavailable';
    try {
      const versionResult = await this.runner.run({
        args: ['--version'],
        command: context.command,
        cwd: context.cwd,
        env: context.env,
        signal,
        timeoutMs: this.options.versionCommandTimeoutMs ?? VERSION_COMMAND_TIMEOUT_MS,
      });
      if (versionResult.exitCode === 0 && !versionResult.termination) {
        version = versionResult.stdout.trim() || version;
      } else {
        version = `unavailable:${versionResult.termination ?? versionResult.exitCode ?? 'unknown'}`;
      }
    } catch {
      version = 'unavailable:error';
    }

    return buildDshCatalogFingerprint({
      command: context.command,
      environmentKeys: context.environmentKeys,
      version,
    });
  }
}

export class SpawnDshCatalogCommandRunner implements DshCatalogCommandRunner {
  run(request: DshCatalogCommandRequest): Promise<DshCatalogCommandResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({ exitCode: null, stdout: '', termination: 'abort' });
    }

    return new Promise((resolve) => {
      const spawnSpec = resolveWindowsCmdShimSpawnSpec(request);
      const proc = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;

      const finish = (result: DshCatalogCommandResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const terminate = (): void => {
        terminateSpawnedProcess(proc, 'SIGKILL', spawn, spawnSpec);
      };
      const onAbort = (): void => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'abort' });
      };
      const timeout = window.setTimeout(() => {
        terminate();
        finish({ exitCode: null, stdout: '', termination: 'timeout' });
      }, request.timeoutMs);

      request.signal?.addEventListener('abort', onAbort, { once: true });
      proc.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_STDOUT_BYTES) {
          terminate();
          finish({ exitCode: null, stdout: '', termination: 'output-limit' });
          return;
        }
        chunks.push(buffer);
      });
      proc.once('error', () => {
        finish({ exitCode: null, stdout: '', termination: 'error' });
      });
      proc.once('close', (exitCode) => {
        finish({ exitCode, stdout: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
}

