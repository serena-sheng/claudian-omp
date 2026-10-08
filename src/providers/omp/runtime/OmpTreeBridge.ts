import { randomUUID } from 'node:crypto';

import { stringifyUnknown } from '@/utils/stringify';

import { type OmpRPCRecord, OmpRPCResponseError, type OmpRPCTransport } from './OmpRPCTransport';

export const OMP_TREE_COMMAND = 'claudian-tree';
const STATUS_PREFIX = 'claudian-tree:';

/** Embedded extension; exceptional leaf restoration uses the hosting OMP SDK. */
export const OMP_TREE_EXTENSION_SOURCE = String.raw`
export default function (omp) {
  let busy = false;
  omp.registerCommand('claudian-tree', {
    description: 'Internal Claudian conversation navigation',
    handler: async (args, ctx) => {
      let request;
      let responseContext = ctx;
      let reloadRequired = false;
      let acquired = false;
      try {
        request = JSON.parse(args);
        if (typeof request.id !== 'string') return;
        if (busy || (request.operation !== 'inspect' && !ctx.isIdle())) throw new Error('OMP is busy');
        busy = acquired = true;
        const manager = ctx.sessionManager;
        if (manager.getSessionId() !== request.sessionId || manager.getSessionFile() !== request.sessionFile) {
          throw new Error('OMP session changed before tree navigation');
        }
        if (request.operation !== 'inspect') {
          const entry = manager.getEntry(request.targetId);
          if (!entry) throw new Error('OMP branch entry is missing');
          const before = entry.type === 'custom_message' || (entry.type === 'message' && entry.message.role === 'user');
          const expected = before ? entry.parentId : entry.id;
          if (request.operation === 'restore' && manager.getLeafId() === request.leafId) {
            // Preserve an incomplete turn at a directly navigable, context-free entry.
            if (before && entry.id === request.leafId) omp.appendEntry('claudian-tree-anchor');
          } else {
            if (request.operation === 'restore' && expected !== request.leafId) {
              if (!before || request.leafId !== entry.id) throw new Error('Invalid OMP branch position');
              // navigateTree(user) selects its parent. A native metadata child preserves
              // this incomplete branch without adding a message to model context.
              const { SessionManager } = await import('@oh-my-pi/pi-coding-agent');
              const disk = SessionManager.open(request.sessionFile);
              if (disk.getSessionId() !== request.sessionId || !disk.getEntry(entry.id)) {
                throw new Error('OMP session changed before branch restoration');
              }
              disk.branch(entry.id);
              const anchorId = disk.appendCustomEntry('claudian-tree-anchor');
              reloadRequired = true;
              const result = await ctx.switchSession(request.sessionFile, {
                withSession: async fresh => {
                  responseContext = fresh;
                  if (fresh.sessionManager.getLeafId() !== anchorId) {
                    const navigation = await fresh.navigateTree(anchorId, { summarize: false });
                    if (navigation.cancelled || fresh.sessionManager.getLeafId() !== anchorId) {
                      throw new Error('OMP branch restoration was interrupted');
                    }
                  }
                  fresh.ui.setStatus('claudian-tree:' + request.id, JSON.stringify({
                    cancelled: false, leafId: anchorId,
                    sessionId: fresh.sessionManager.getSessionId(), sessionFile: fresh.sessionManager.getSessionFile()
                  }));
                }
              });
              if (result.cancelled) ctx.ui.setStatus('claudian-tree:' + request.id, JSON.stringify({ cancelled: true, reloadRequired: true }));
              return;
            }
            // Native navigateTree is a no-op when its target is the current leaf.
            if (before && manager.getLeafId() === entry.id) omp.appendEntry('claudian-tree-anchor');
            const result = await ctx.navigateTree(request.targetId, { summarize: false });
            if (result.cancelled) {
              ctx.ui.setStatus('claudian-tree:' + request.id, JSON.stringify({ cancelled: true }));
              return;
            }
            if (manager.getLeafId() !== expected) throw new Error('OMP branch position changed during navigation');
          }
        }
        ctx.ui.setStatus('claudian-tree:' + request.id, JSON.stringify({
          cancelled: false, leafId: manager.getLeafId(),
          sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()
        }));
      } catch (error) {
        if (request && typeof request.id === 'string') {
          responseContext.ui.setStatus('claudian-tree:' + request.id, JSON.stringify({ error: String(error.message || error), uncertain: reloadRequired }));
        }
      } finally {
        if (acquired) busy = false;
      }
    }
  });
}
`;

export function isOmpTreeResponse(event: OmpRPCRecord): boolean {
  return event.type === 'extension_ui_request' && event.method === 'setStatus'
    && typeof event.statusKey === 'string' && event.statusKey.startsWith(STATUS_PREFIX);
}

/** Correlate an extension result separately from RPC's prompt acceptance. */
export async function requestOmpTree(
  transport: OmpRPCTransport,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const catalog = await transport.request<{ commands?: Array<{ name: string }> }>('get_available_commands', {}, 10_000, signal);
  if (!catalog.commands?.some(command => command.name === OMP_TREE_COMMAND)) {
    throw new OmpRPCResponseError('claudian_tree', 'OMP conversation branching extension is unavailable.');
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    let removeEvent = () => {};
    let removeClose = () => {};
    const cleanup = () => {
      window.clearTimeout(timer);
      removeEvent();
      removeClose();
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); };
    const abort = () => fail(new Error('OMP tree navigation cancelled'));
    const timer = window.setTimeout(() => fail(new Error('OMP tree navigation timed out')), 10_000);
    removeClose = transport.onClose(error => fail(error ?? new Error('OMP process closed')));
    removeEvent = transport.onEvent(event => {
      if (!isOmpTreeResponse(event) || event.statusKey !== STATUS_PREFIX + id) return;
      try {
        const result: unknown = JSON.parse(String(event.statusText));
        if (!result || typeof result !== 'object') throw new Error('Invalid OMP tree response');
        if ('error' in result && result.error) {
          if ('uncertain' in result && result.uncertain) throw new Error(stringifyUnknown(result.error), { cause: result.error });
          throw new OmpRPCResponseError('claudian_tree', stringifyUnknown(result.error));
        }
        cleanup();
        resolve(result);
      } catch (error) { fail(error); }
    });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    void transport.request('prompt', {
      message: '/' + OMP_TREE_COMMAND + ' ' + JSON.stringify({ ...payload, id }),
    }, 10_000, signal).catch(fail);
  });
}
