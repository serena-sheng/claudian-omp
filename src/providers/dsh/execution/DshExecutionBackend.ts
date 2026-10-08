import type {
  ProviderExecutionBackend,
  ProviderExecutionSession,
  ProviderSessionConfig,
} from '../../../core/execution';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import type {
  ACPLoadSessionRequest,
  ACPLoadSessionResponse,
  ACPNewSessionRequest,
  ACPNewSessionResponse,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionConfigOption,
  ACPSessionNotification,
} from '../../acp';
import type { DshCommandCatalog } from '../commands/DshCommandCatalog';
import type { DshModelCatalogCoordinator } from '../runtime/DshModelCatalogCoordinator';
import { DshExecutionNativeConnectionImpl } from './DshExecutionNativeConnection';
import { DshExecutionSession } from './DshExecutionSession';

export interface DshExecutionNativeConnection {
  cancel(sessionId: string): void;
  flush?(): Promise<void>;
  initialize(): Promise<void>;
  isAlive?(): boolean;
  /** Maps to dsh's `session/resume` via the connection's method-name override. */
  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse>;
  listCommands(cwd: string, signal?: AbortSignal): Promise<SlashCommand[]>;
  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse>;
  onNotification(
    listener: (notification: ACPSessionNotification) => void,
  ): () => void;
  onClose?(listener: (error?: Error) => void): () => void;
  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse>;
  /** dsh has no `session/set_model`; implemented as `session/set_config_option` on the `model` option. */
  setModel(request: {
    modelId: string;
    sessionId: string;
  }): Promise<{ configOptions?: ACPSessionConfigOption[] | null }>;
  shutdown(): Promise<void>;
}

export interface DshExecutionNativeCreateOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly requestPermission: (
    request: ACPRequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<ACPRequestPermissionResponse>;
  readonly version: string;
}

export interface DshExecutionNativeFactory {
  create(options: DshExecutionNativeCreateOptions): DshExecutionNativeConnection;
}

export interface DshExecutionBackendOptions {
  readonly commandCatalog?: Pick<DshCommandCatalog, 'setCommandSnapshot'>;
  readonly modelCatalogCoordinator?: Pick<DshModelCatalogCoordinator, 'mergeLiveModels'>;
  readonly nativeFactory?: DshExecutionNativeFactory;
}

export class DshExecutionBackend implements ProviderExecutionBackend {
  readonly providerId = 'dsh' as const;
  private readonly nativeFactory: DshExecutionNativeFactory;

  constructor(
    private readonly plugin: ProviderHost,
    private readonly options: DshExecutionBackendOptions = {},
  ) {
    this.nativeFactory = options.nativeFactory ?? {
      create: nativeOptions => new DshExecutionNativeConnectionImpl(nativeOptions),
    };
  }

  createSession(config: ProviderSessionConfig): ProviderExecutionSession {
    return new DshExecutionSession(this.plugin, config, {
      commandCatalog: this.options.commandCatalog,
      modelCatalogCoordinator: this.options.modelCatalogCoordinator,
      nativeFactory: this.nativeFactory,
    });
  }
}
