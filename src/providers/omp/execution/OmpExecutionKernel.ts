import type { StreamChunk } from '../../../core/types';
import {
  OmpExtensionUIBridge,
  type OmpExtensionUIRenderer,
} from '../runtime/OmpExtensionUIBridge';
import type { OmpLaunchSpec } from '../runtime/OmpLaunchSpecBuilder';
import {
  type OmpRPCRecord,
  OmpRPCTransport,
} from '../runtime/OmpRPCTransport';
import { OmpSubprocess } from '../runtime/OmpSubprocess';
import { isOmpTreeResponse, OMP_TREE_EXTENSION_SOURCE, requestOmpTree } from '../runtime/OmpTreeBridge';

export interface OmpExecutionKernelCallbacks {
  onClose(error?: Error): void;
  onEvent(event: OmpRPCRecord): void;
  onExtensionChunk(chunk: StreamChunk): void;
  onExtensionRequest(request: OmpRPCRecord): boolean;
}

export interface OmpExecutionKernel {
  readonly launchSpec: OmpLaunchSpec;
  getStderrSnapshot(): string;
  request<T>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  send(record: OmpRPCRecord): void;
  shutdown(): Promise<void>;
  start(): void;
}

export type OmpExecutionKernelFactory = (
  launchSpec: OmpLaunchSpec,
  callbacks: OmpExecutionKernelCallbacks,
  extensionUiRenderer: OmpExtensionUIRenderer | null,
) => OmpExecutionKernel;

export class OmpRPCSessionKernel implements OmpExecutionKernel {
  private readonly subprocess: OmpSubprocess;
  private transport: OmpRPCTransport | null = null;
  private extensionBridge: OmpExtensionUIBridge | null = null;
  private removeCloseListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private started = false;
  private shutdownPromise: Promise<void> | null = null;
  private treeExtensionDirectory: string | null = null;

  constructor(
    readonly launchSpec: OmpLaunchSpec,
    private readonly callbacks: OmpExecutionKernelCallbacks,
    extensionUiRenderer: OmpExtensionUIRenderer | null,
  ) {
    let processSpec = launchSpec;
    if (launchSpec.enableTreeBridge) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-omp-tree-'));
      try {
        const extension = path.join(directory, 'extension.ts');
        fs.writeFileSync(extension, OMP_TREE_EXTENSION_SOURCE, 'utf8');
        processSpec = { ...launchSpec, args: [...launchSpec.args, '--extension', extension] };
        this.treeExtensionDirectory = directory;
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    }
    this.subprocess = new OmpSubprocess(processSpec);
    this.extensionUiRenderer = extensionUiRenderer;
  }

  private readonly extensionUiRenderer: OmpExtensionUIRenderer | null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subprocess.start();
    const transport = new OmpRPCTransport({
      input: this.subprocess.stdout,
      onClose: listener => this.subprocess.onClose(listener),
      output: this.subprocess.stdin,
    });
    const extensionBridge = new OmpExtensionUIBridge(
      transport,
      this.extensionUiRenderer,
      chunk => this.callbacks.onExtensionChunk(chunk),
      request => this.callbacks.onExtensionRequest(request),
    );
    this.transport = transport;
    this.extensionBridge = extensionBridge;
    transport.start();
    this.removeEventListener = transport.onEvent((event) => {
      if (isOmpTreeResponse(event)) return;
      if (event.type === 'extension_ui_request') {
        extensionBridge.handleRequest(event);
        return;
      }
      this.callbacks.onEvent(event);
    });
    this.removeCloseListener = transport.onClose(error => {
      this.callbacks.onClose(error);
    });
  }

  getStderrSnapshot(): string {
    return this.subprocess.getStderrSnapshot();
  }

  request<T>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (type === 'claudian_tree') {
      return requestOmpTree(this.#requireTransport(), payload, signal) as Promise<T>;
    }
    return this.#requireTransport().request(type, payload, timeoutMs, signal);
  }

  send(record: OmpRPCRecord): void {
    this.#requireTransport().send(record);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.#shutdownInternal();
    return this.shutdownPromise;
  }

  async #shutdownInternal(): Promise<void> {
    this.extensionBridge?.cleanup();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.transport?.dispose();
    this.transport = null;
    this.extensionBridge = null;
    await this.subprocess.shutdown();
    if (this.treeExtensionDirectory) {
      await fsp.rm(this.treeExtensionDirectory, { recursive: true, force: true });
      this.treeExtensionDirectory = null;
    }
  }

  #requireTransport(): OmpRPCTransport {
    if (!this.transport) {
      throw new Error('OMP execution kernel is not started');
    }
    return this.transport;
  }
}

export const createOmpExecutionKernel: OmpExecutionKernelFactory = (
  launchSpec,
  callbacks,
  extensionUiRenderer,
) => new OmpRPCSessionKernel(
  launchSpec,
  callbacks,
  extensionUiRenderer,
);
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
