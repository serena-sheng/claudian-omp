import { ACPJSONRPCTransport, ACPSubprocess } from '../../acp';
import { ACP_METHOD_NAMES } from '../../acp/methodNames';
import type { ACPNewSessionResponse } from '../../acp/types';
import {
  type NormalizedDshSessionModels,
  normalizeDshSessionModelMetadata,
} from '../execution/DshSessionModelMetadata';

export interface DshModelCatalogProbeRequest {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  version: string;
}

export interface DshModelCatalogProbeLike {
  discover(request: DshModelCatalogProbeRequest): Promise<NormalizedDshSessionModels>;
}

/**
 * Owns a short-lived ACP process. dsh publishes its model catalog through the
 * `session/new` response `configOptions` (a grouped `select` whose values are
 * JSON-encoded `[route, model]` pairs), so discovery creates and closes one
 * session instead of calling a provider-specific extension method.
 */
export class DshModelCatalogProbe implements DshModelCatalogProbeLike {
  async discover(request: DshModelCatalogProbeRequest): Promise<NormalizedDshSessionModels> {
    request.signal?.throwIfAborted();
    const process = new ACPSubprocess({
      args: ['--profile', 'acp'],
      command: request.command,
      cwd: request.cwd,
      env: request.env,
    });
    let transport: ACPJSONRPCTransport | undefined;
    let sessionId: string | undefined;
    try {
      process.start();
      transport = new ACPJSONRPCTransport({
        input: process.stdout,
        onClose: listener => process.onClose(listener),
        output: process.stdin,
      });
      const options = { signal: request.signal, timeoutMs: request.timeoutMs };
      await transport.request(ACP_METHOD_NAMES.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'claudian', version: request.version },
      }, options);
      const response = await transport.request<ACPNewSessionResponse | null>(
        ACP_METHOD_NAMES.newSession,
        { cwd: request.cwd, mcpServers: [] },
        options,
      );
      sessionId = response?.sessionId;
      if (!sessionId) throw new Error('DeepSeek Harness returned no session id for model discovery.');
      const catalog = normalizeDshSessionModelMetadata({
        configOptions: response?.configOptions ?? null,
      });
      // The configOptions snapshot is complete; session updates may be partial.
      return {
        ...catalog,
        models: catalog.models.map(model => ({ ...model, reasoningMetadataResolved: true })),
      };
    } finally {
      if (transport && sessionId) {
        // Best effort: dsh supports session/close; ignore failures during teardown.
        await transport.request('session/close', { sessionId }, { timeoutMs: 2_000 }).catch(() => undefined);
      }
      transport?.dispose();
      await process.shutdown();
    }
  }
}
