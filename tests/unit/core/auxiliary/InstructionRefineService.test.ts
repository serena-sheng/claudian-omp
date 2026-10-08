import {
  FakeAuxiliaryBackend,
  waitFor,
} from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { InstructionRefineService } from '@/core/auxiliary/InstructionRefineService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new InstructionRefineService({
    backend,
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
    },
    lifecycleRegistry,
    nativePersistence: 'provider-default',
    vaultWorkingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

describe('InstructionRefineService', () => {
  it('keeps clarification continuity in an independent passive session', async () => {
    const { backend, service } = createService();
    service.setModelOverride('refine-model');
    const first = service.refineInstruction('make it faster');
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which part is slow?');
    backend.sessions[0].complete();
    await expect(first).resolves.toMatchObject({
      clarification: 'Which part is slow?',
      success: true,
    });

    const second = service.continueConversation('The search query');
    await waitFor(() => backend.sessions[0]?.requests.length === 2);
    backend.sessions[0].emitText('<instruction>Optimize the search query.</instruction>');
    backend.sessions[0].complete();
    await expect(second).resolves.toMatchObject({
      refinedInstruction: 'Optimize the search query.',
      success: true,
    });

    expect(backend.sessions).toHaveLength(1);
    expect(backend.configs[0]).toMatchObject({
      lifecycle: 'ephemeral',
      nativePersistence: 'provider-default',
    });
    expect(backend.sessions[0].requests[0]).toMatchObject({
      configuration: {
        model: 'refine-model',
        systemInstructions: {
          instructions: expect.stringContaining('Prompt Engineer'),
          kind: 'explicit',
        },
      },
      toolPolicy: { kind: 'passive' },
    });
    expect(backend.sessions[0].requests[0].input[0]).toMatchObject({
      text: expect.stringContaining('make it faster'),
      type: 'text',
    });
  });

  it('requires an explicit root refine after transition invalidates continuity', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const first = service.refineInstruction('make it faster');
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which part is slow?');
    backend.sessions[0].complete();
    await first;

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);
    await expect(service.continueConversation('The search query')).resolves.toMatchObject({
      resetRequired: true,
      success: false,
    });

    const restarted = service.refineInstruction('write tests');
    await waitFor(() => backend.sessions.length === 2);
    expect(backend.sessions).toHaveLength(2);
    backend.sessions[1].emitText('<instruction>Write unit tests.</instruction>');
    backend.sessions[1].complete();
    await expect(restarted).resolves.toMatchObject({
      refinedInstruction: 'Write unit tests.',
      success: true,
    });
  });

  it('fails instead of continuing without an active conversation', async () => {
    const { service } = createService();
    await expect(service.continueConversation('details')).resolves.toMatchObject({
      success: false,
      error: 'No active conversation to continue',
    });
  });
});
