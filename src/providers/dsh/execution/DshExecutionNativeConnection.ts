import type { SlashCommand } from '../../../core/types';

import {
  ACPClientConnection,
  ACPJSONRPCTransport,
  ACPSubprocess,
} from '../../acp';
import type {
  DshExecutionNativeConnection,
  DshExecutionNativeCreateOptions,
} from './DshExecutionBackend';

/** dsh resumes sessions with `session/resume`; it has no `session/load`. */
const DSH_METHOD_NAME_OVERRIDES = { loadSession: 'session/resume' } as const;

/**
 * ACP connection to `dsh --profile acp`. dsh speaks plain ACP v1: there are no
 * provider extension methods (no `_x.ai/*` equivalents), no interjection, mode,
 * or model-push notifications, and no fork/rewind.
 */
export class DshExecutionNativeConnectionImpl
implements DshExecutionNativeConnection {
  private readonly connection: ACPClientConnection;
  private readonly listeners = new Set<Parameters<DshExecutionNativeConnection['onNotification']>[0]>();
  private readonly process: ACPSubprocess;
  private readonly transport: ACPJSONRPCTransport;

  constructor(options: DshExecutionNativeCreateOptions) {
    this.process = new ACPSubprocess({
      args: ['--profile', 'acp'],
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    });
    this.process.start();
    this.transport = new ACPJSONRPCTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.connection = new ACPClientConnection({
      clientInfo: { name: 'claudian', version: options.version },
      delegate: {
        onSessionNotification: notification => this.notify(notification),
        requestPermission: request => options.requestPermission(request),
      },
      methodNameOverrides: DSH_METHOD_NAME_OVERRIDES,
      transport: this.transport,
    });
  }

  cancel(sessionId: string): void {
    this.connection.cancel({ sessionId });
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  async initialize(): Promise<void> {
    await this.connection.initialize();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.process.onClose(listener);
  }

  loadSession: DshExecutionNativeConnection['loadSession'] = request => (
    this.connection.loadSession(request)
  );

  // dsh exposes no command-listing endpoint; slash commands arrive through
  // standard `available_commands_update` session notifications instead.
  listCommands(): Promise<SlashCommand[]> {
    return Promise.resolve([]);
  }

  newSession: DshExecutionNativeConnection['newSession'] = request => (
    this.connection.newSession(request)
  );

  onNotification(
    listener: Parameters<DshExecutionNativeConnection['onNotification']>[0],
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt: DshExecutionNativeConnection['prompt'] = request => (
    this.connection.prompt(request)
  );

  setModel: DshExecutionNativeConnection['setModel'] = request => (
    this.connection.setConfigOption({
      configId: 'model',
      sessionId: request.sessionId,
      type: 'select',
      value: request.modelId,
    })
  );

  async shutdown(): Promise<void> {
    this.listeners.clear();
    this.connection.dispose();
    this.transport.dispose();
    await this.process.shutdown();
  }

  private notify(
    notification: Parameters<Parameters<DshExecutionNativeConnection['onNotification']>[0]>[0],
  ): void {
    for (const listener of this.listeners) listener(notification);
  }
}
