import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type {
  InstructionRefineResult,
  InstructionRefineService,
} from '@/core/providers/types';
import type { InstructionModeManager } from '@/features/chat/composer/InstructionModeManager';
import {
  InstructionSubmissionController,
  type InstructionSubmissionControllerDeps,
} from '@/features/chat/input/InstructionSubmissionController';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';
import type { InstructionRefineModalCallbacks } from '@/shared/modals/InstructionRefineModal';

interface MockModalInstance {
  open: jest.Mock;
  close: jest.Mock;
  showError: jest.Mock;
  showConfirmation: jest.Mock;
  showClarification: jest.Mock;
  callbacks: InstructionRefineModalCallbacks;
}

const mockModalInstances: MockModalInstance[] = [];

jest.mock('@/shared/modals/InstructionRefineModal', () => ({
  InstructionRefineModal: jest.fn().mockImplementation(
    (_app: unknown, _raw: string, callbacks: InstructionRefineModalCallbacks) => {
      const instance: MockModalInstance = {
        open: jest.fn(),
        close: jest.fn(),
        showError: jest.fn(),
        showConfirmation: jest.fn(),
        showClarification: jest.fn(),
        callbacks,
      };
      mockModalInstances.push(instance);
      return instance;
    },
  ),
}));

function createService(overrides: Partial<InstructionRefineService> = {}): InstructionRefineService {
  return {
    setModelOverride: jest.fn(),
    resetConversation: jest.fn(),
    refineInstruction: jest.fn(),
    continueConversation: jest.fn(),
    cancel: jest.fn(),
    ...overrides,
  };
}

function createHarness(options: {
  unsupported?: boolean;
  service?: InstructionRefineService;
  refineResult?: InstructionRefineResult;
}) {
  const inputEl = {
    value: 'rough draft',
    placeholder: '',
    focus: jest.fn(),
  } as unknown as ComposerInputElement;
  const modeManager = { deactivate: jest.fn() } as unknown as InstructionModeManager;
  const service = options.unsupported
    ? null
    : options.service
      ?? createService({
        refineInstruction: jest.fn().mockResolvedValue(options.refineResult),
      });

  const spy = jest.spyOn(ProviderRegistry, 'createInstructionRefineService')
    .mockReturnValue(service);

  const deps: InstructionSubmissionControllerDeps = {
    plugin: { app: {}, providerHost: {} } as unknown as InstructionSubmissionControllerDeps['plugin'],
    getInputEl: () => inputEl,
    getInstructionModeManager: () => modeManager,
    getTabProviderId: () => 'claude',
    getModelOverride: () => undefined,
    ensureExecutionInitialized: () => Promise.resolve(true),
  };
  const controller = new InstructionSubmissionController(deps);
  return { controller, inputEl, modeManager, service, spy };
}

const noticeMock = Notice as unknown as jest.Mock;

afterEach(() => {
  jest.restoreAllMocks();
  mockModalInstances.length = 0;
  noticeMock.mockClear();
});

describe('InstructionSubmissionController draft preservation', () => {
  it('keeps the draft when the provider does not support refinement', async () => {
    const { controller, inputEl, modeManager } = createHarness({ unsupported: true });

    await controller.submit('rough draft');

    expect(modeManager.deactivate).toHaveBeenCalledTimes(1);
    expect(inputEl.value).toBe('rough draft');
  });

  it('keeps the draft when the user rejects the refined prompt', async () => {
    const { controller, inputEl, modeManager, service } = createHarness({
      refineResult: { success: true, refinedInstruction: 'polished prompt' },
    });

    await controller.submit('rough draft');
    expect(mockModalInstances[0].showConfirmation).toHaveBeenCalledWith('polished prompt');

    mockModalInstances[0].callbacks.onReject();

    expect((service as InstructionRefineService).cancel).toHaveBeenCalled();
    expect(modeManager.deactivate).toHaveBeenCalledTimes(1);
    expect(inputEl.value).toBe('rough draft');
  });

  it('keeps the draft when refinement returns an error result', async () => {
    const { controller, inputEl, modeManager } = createHarness({
      refineResult: { success: false, error: 'provider exploded' },
    });

    await controller.submit('rough draft');

    expect(mockModalInstances[0].showError).toHaveBeenCalledTimes(1);
    expect(modeManager.deactivate).toHaveBeenCalledTimes(1);
    expect(inputEl.value).toBe('rough draft');
  });

  it('keeps the draft when refinement throws', async () => {
    const service = createService({
      refineInstruction: jest.fn().mockRejectedValue(new Error('network down')),
    });
    const { controller, inputEl, modeManager } = createHarness({ service });

    await controller.submit('rough draft');

    expect(mockModalInstances[0].showError).toHaveBeenCalledTimes(1);
    expect(modeManager.deactivate).toHaveBeenCalledTimes(1);
    expect(inputEl.value).toBe('rough draft');
  });

  it('treats a lowercase "cancelled" result as cancellation, not failure', async () => {
    const { controller, modeManager } = createHarness({
      refineResult: { success: false, error: 'cancelled' },
    });

    await controller.submit('rough draft');

    expect(mockModalInstances[0].showError).not.toHaveBeenCalled();
    expect(modeManager.deactivate).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('backfills the accepted prompt through the composer', async () => {
    const { controller, inputEl, modeManager } = createHarness({
      refineResult: { success: true, refinedInstruction: 'polished prompt' },
    });

    await controller.submit('rough draft');
    mockModalInstances[0].callbacks.onAccept('polished prompt');

    expect(inputEl.value).toBe('polished prompt');
    expect(modeManager.deactivate).toHaveBeenCalledTimes(1);
  });
});

describe('InstructionSubmissionController.cancel', () => {
  it('closes the modal opened by an in-flight submit', async () => {
    // tsconfig lib predates Promise.withResolvers; the promise must never settle.
    const pending = new Promise<InstructionRefineResult>(() => {});
    const service = createService({
      refineInstruction: jest.fn().mockReturnValue(pending),
    });
    const { controller } = createHarness({ service });

    const submission = controller.submit('rough draft');
    // The modal is created after the ensureExecutionInitialized() await resolves.
    await Promise.resolve();
    expect(mockModalInstances[0].open).toHaveBeenCalledTimes(1);

    controller.cancel();

    expect(service.cancel).toHaveBeenCalled();
    expect(mockModalInstances[0].close).toHaveBeenCalledTimes(1);

    // A second cancel must not double-close.
    controller.cancel();
    expect(mockModalInstances[0].close).toHaveBeenCalledTimes(1);

    submission.catch(() => {});
  });
});
