import type { StreamChunk } from '../../../core/types';
import type { OmpRPCRecord, OmpRPCTransport } from './OmpRPCTransport';

export interface OmpExtensionUISelectRequest extends OmpRPCRecord {
  id: string;
}

export interface OmpExtensionUIConfirmRequest extends OmpRPCRecord {
  id: string;
}

export interface OmpExtensionUIInputRequest extends OmpRPCRecord {
  id: string;
}

export interface OmpExtensionUIEditorRequest extends OmpRPCRecord {
  id: string;
}

export type OmpExtensionUINotifyRequest = OmpRPCRecord;
export type OmpExtensionUISetEditorTextRequest = OmpRPCRecord;
export type OmpExtensionUISetStatusRequest = OmpRPCRecord;
export type OmpExtensionUISetTitleRequest = OmpRPCRecord;
export type OmpExtensionUISetWidgetRequest = OmpRPCRecord;

export interface OmpExtensionUIRenderer {
  confirm(request: OmpExtensionUIConfirmRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; confirmed?: boolean }>;
  editor(request: OmpExtensionUIEditorRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  input(request: OmpExtensionUIInputRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  notify(request: OmpExtensionUINotifyRequest): void;
  select(request: OmpExtensionUISelectRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  setEditorText(request: OmpExtensionUISetEditorTextRequest): void;
  setStatus(request: OmpExtensionUISetStatusRequest): void;
  setTitle(request: OmpExtensionUISetTitleRequest): void;
  setWidget(request: OmpExtensionUISetWidgetRequest): void;
}

export class OmpExtensionUIBridge {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly transport: OmpRPCTransport,
    private readonly renderer: OmpExtensionUIRenderer | null,
    private readonly emit?: (chunk: StreamChunk) => void,
    private readonly admitDialog: (request: OmpRPCRecord) => boolean = () => true,
  ) {}

  handleRequest(request: OmpRPCRecord): boolean {
    if (request.type !== 'extension_ui_request') {
      return false;
    }

    const method = getString(request.method) ?? getString(request.action) ?? getString(request.uiType);
    switch (method) {
      case 'select':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.select(requireDialogRequest(request), signal));
        return true;
      case 'confirm':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.confirm(requireDialogRequest(request), signal));
        return true;
      case 'input':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.input(requireDialogRequest(request), signal));
        return true;
      case 'editor':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.editor(requireDialogRequest(request), signal));
        return true;
      case 'notify':
        this.renderer?.notify(request);
        this.emit?.({
          type: 'notice',
          content: getString(request.message) ?? getString(request.title) ?? 'OMP extension notification.',
          level: 'info',
        });
        return true;
      case 'setStatus':
      case 'set_status':
        this.renderer?.setStatus(request);
        return true;
      case 'setWidget':
      case 'set_widget':
        this.renderer?.setWidget(request);
        return true;
      case 'setTitle':
      case 'set_title':
        this.renderer?.setTitle(request);
        return true;
      case 'setEditorText':
      case 'set_editor_text':
        this.renderer?.setEditorText(request);
        return true;
      default:
        this.#sendCancellation(request);
        return true;
    }
  }

  cleanup(): void {
    for (const [id, controller] of this.pending) {
      controller.abort();
      this.#sendResponse(id, { cancelled: true });
    }
    this.pending.clear();
  }

  #handleDialog(
    request: OmpRPCRecord,
    render: (
      renderer: OmpExtensionUIRenderer,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>,
  ): void {
    const id = getString(request.id);
    if (!id || !this.renderer || !this.admitDialog(request)) {
      this.#sendCancellation(request);
      return;
    }

    const controller = new AbortController();
    this.pending.set(id, controller);
    render(this.renderer, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          this.#sendResponse(id, response.cancelled ? { cancelled: true } : response);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.#sendResponse(id, { cancelled: true });
        }
      })
      .finally(() => {
        this.pending.delete(id);
      });
  }

  #sendCancellation(request: OmpRPCRecord): void {
    const id = getString(request.id);
    if (id) {
      this.#sendResponse(id, { cancelled: true });
    }
  }

  #sendResponse(id: string, response: Record<string, unknown>): void {
    this.transport.send({
      id,
      type: 'extension_ui_response',
      ...response,
    });
  }
}

function requireDialogRequest<T extends OmpRPCRecord & { id: string }>(request: OmpRPCRecord): T {
  return request as T;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
