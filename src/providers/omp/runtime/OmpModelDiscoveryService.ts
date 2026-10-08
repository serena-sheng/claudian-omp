import { parseEnvironmentVariables } from '@/core/process/env';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { getVaultPath } from '../../../utils/path';
import {
  normalizeOmpDiscoveredModels,
  type OmpDiscoveredModel,
} from '../models';
import { getOmpProviderSettings } from '../settings';
import { buildOmpEnvironment, buildOmpLaunchSpec } from './OmpLaunchSpecBuilder';
import { OmpRPCTransport } from './OmpRPCTransport';
import { OmpSubprocess } from './OmpSubprocess';

export type OmpModelDiscoveryResult =
  | {
    kind: 'completed';
    diagnostics?: string;
    models: OmpDiscoveredModel[];
  }
  | {
    kind: 'skipped';
    reason: 'provider-disabled';
  };

export class OmpModelDiscoveryService {
  constructor(private readonly plugin: ProviderHost) {}

  async discoverModels(signal?: AbortSignal): Promise<OmpModelDiscoveryResult> {
    const settings = getOmpProviderSettings(this.plugin.settings);
    if (!settings.enabled) {
      return { kind: 'skipped', reason: 'provider-disabled' };
    }

    const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
    const command = await this.plugin.getResolvedProviderCliPath('omp') ?? 'omp';
    const envText = getRuntimeEnvironmentText(this.plugin.settings, 'omp');
    const env = buildOmpEnvironment(process.env, parseEnvironmentVariables(envText));
    const launchSpec = buildOmpLaunchSpec({
      command,
      cwd,
      env,
      envText,
      noSession: true,
      settings,
    });
    const subprocess = new OmpSubprocess(launchSpec);
    let transport: OmpRPCTransport | null = null;
    let removeEventListener: (() => void) | null = null;

    const abort = () => { transport?.dispose(); void subprocess.shutdown().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      subprocess.start();
      transport = new OmpRPCTransport({
        input: subprocess.stdout,
        onClose: (listener) => subprocess.onClose(listener),
        output: subprocess.stdin,
      });
      transport.start();
      removeEventListener = transport.onEvent((event) => {
        if (event.type !== 'extension_ui_request') {
          return;
        }

        const id = typeof event.id === 'string' && event.id.trim() ? event.id.trim() : '';
        if (id) {
          transport?.send({
            cancelled: true,
            id,
            type: 'extension_ui_response',
          });
        }
      });
      const response = await transport.request('get_available_models', {}, 20_000);
      const models = normalizeOmpDiscoveredModels(extractModels(response)).map(model => {
        // This complete native response is authoritative, including non-reasoning models.
        delete model.reasoningMetadataResolved;
        return model;
      });
      return { kind: 'completed', models };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OMP model discovery failed';
      const stderr = subprocess.getStderrSnapshot();
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        kind: 'completed',
        models: [],
      };
    } finally {
      signal?.removeEventListener('abort', abort);
      removeEventListener?.();
      transport?.dispose();
      await subprocess.shutdown().catch(() => {});
    }
  }
}

function extractModels(response: unknown): unknown {
  if (Array.isArray(response)) {
    return response;
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    return record.models ?? record.availableModels ?? record.available_models ?? [];
  }
  return [];
}
