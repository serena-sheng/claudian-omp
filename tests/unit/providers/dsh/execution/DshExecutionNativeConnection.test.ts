import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { getInstallationKey as getHostnameKey } from '@/core/device/InstallationKey';

jest.mock('cross-spawn', () => jest.fn());

import spawn from 'cross-spawn';

import type { ProviderExecutionEvent, ProviderExecutionRequest } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ACPJSONRPCTransport } from '@/providers/acp';
import { DshExecutionBackend } from '@/providers/dsh/execution/DshExecutionBackend';
import { DshExecutionNativeConnectionImpl } from '@/providers/dsh/execution/DshExecutionNativeConnection';

const initializeResult = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
};

function createNativeProcess() {
  const proc = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    pid: 12345,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => {
      proc.exitCode = 0;
      proc.killed = true;
      proc.emit('exit', 0, null);
      return true;
    },
  });
  jest.mocked(spawn).mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
  return proc;
}

function createConnection(): {
  connection: DshExecutionNativeConnectionImpl;
  native: ACPJSONRPCTransport;
} {
  const proc = createNativeProcess();
  const native = new ACPJSONRPCTransport({ input: proc.stdin, output: proc.stdout });
  native.onRequest('initialize', () => initializeResult);
  native.start();
  const connection = new DshExecutionNativeConnectionImpl({
    command: '/opt/dsh',
    cwd: '/vault',
    env: {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    version: 'test',
  });
  return { connection, native };
}

function createPromptChannel(): {
  promise: Promise<{ stopReason: string }>;
  resolve: (value: { stopReason: string }) => void;
} {
  let resolve!: (value: { stopReason: string }) => void;
  const promise = new Promise<{ stopReason: string }>(resolver => { resolve = resolver; });
  return { promise, resolve };
}

describe('DshExecutionNativeConnection', () => {

  it('spawns the dsh CLI with the acp profile', () => {
    const { connection } = createConnection();

    expect(spawn).toHaveBeenCalledWith(
      '/opt/dsh',
      ['--profile', 'acp'],
      expect.objectContaining({ cwd: '/vault' }),
    );

    return connection.shutdown();
  });

  it('maps loadSession to the session/resume wire method', async () => {
    const { connection, native } = createConnection();
    const resume = jest.fn(() => ({ sessionId: 'session-resumed' }));
    native.onRequest('session/resume', resume);
    try {
      await connection.initialize();

      await expect(connection.loadSession({
        cwd: '/vault',
        mcpServers: [],
        sessionId: 'session-resumed',
      })).resolves.toEqual({ sessionId: 'session-resumed' });
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      await connection.shutdown();
    }
  });

  it('implements setModel as a select update on the model config option', async () => {
    const { connection, native } = createConnection();
    const rawId = '["deepseek-official","deepseek-v4-flash"]';
    const setConfigOption = jest.fn(() => ({
      configOptions: [{
        category: 'model',
        currentValue: rawId,
        id: 'model',
        name: 'Model',
        options: [{ name: 'Flash', value: rawId }],
        type: 'select',
      }],
    }));
    native.onRequest('session/set_config_option', setConfigOption);
    try {
      await connection.initialize();

      await expect(connection.setModel({
        modelId: rawId,
        sessionId: 'session-1',
      })).resolves.toEqual(expect.objectContaining({
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'model', currentValue: rawId }),
        ]),
      }));
      expect(setConfigOption).toHaveBeenCalledWith(
        expect.objectContaining({
          configId: 'model',
          sessionId: 'session-1',
          type: 'select',
          value: rawId,
        }),
        expect.anything(),
      );
    } finally {
      await connection.shutdown();
    }
  });

  it('resolves no commands because dsh pushes them through session notifications', async () => {
    const { connection } = createConnection();
    try {
      await connection.initialize();

      await expect(connection.listCommands()).resolves.toEqual([]);
    } finally {
      await connection.shutdown();
    }
  });

  it('forwards session notifications until the listener unsubscribes', async () => {
    const { connection, native } = createConnection();
    const listener = jest.fn();
    const settle = async () => {
      await native.flush();
      for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
    };
    try {
      await connection.initialize();
      const unsubscribe = connection.onNotification(listener);
      const notification = {
        sessionId: 'session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      };

      native.notify('session/update', notification);
      await settle();
      expect(listener).toHaveBeenCalledWith(notification);

      unsubscribe();
      native.notify('session/update', notification);
      await settle();
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await connection.shutdown();
    }
  });
});

it.each([false, true])('terminates on native exit after prompt settled: %s', async settled => {
  const proc = createNativeProcess();
  const native = new ACPJSONRPCTransport({ input: proc.stdin, output: proc.stdout });
  const { promise: prompt, resolve: resolvePrompt } = createPromptChannel();
  let started = false;
  native.onRequest('initialize', () => initializeResult);
  native.onRequest('session/new', () => ({ sessionId: 'session' }));
  native.onRequest('session/prompt', () => { started = true; return prompt; });
  native.start();
  const session = new DshExecutionBackend({ getResolvedProviderCliPath: async () => 'dsh', settings: { model: 'dsh:dsh-4', providerConfigs: { dsh: { enabled: true, visibleModels: ['dsh-4'], selectedModelsByHost: { [getHostnameKey()]: { fingerprint: 'test', refreshedAt: 1, defaultModelId: 'dsh-4', models: [{ rawId: 'dsh-4', displayName: 'Dsh 4', supportsReasoning: false, reasoningEfforts: [] }] } } } } } } as unknown as ProviderHost, {
    nativeFactory: { create: options => new DshExecutionNativeConnectionImpl(options) },
  }).createSession({
    vaultWorkingDirectory: '/tmp', lifecycle: 'persistent', nativePersistence: 'enabled',
    interactionPort: { askUserQuestion: jest.fn(), dismissInteraction: jest.fn(), requestApproval: jest.fn() },
  });
  const request: ProviderExecutionRequest = {
    configuration: { permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Answer.' } },
    input: [{ type: 'text', text: 'hello' }], signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
  const events: ProviderExecutionEvent[] = [];
  const collection = (async () => { for await (const event of session.execute(request).events) events.push(event); })();
  try {
    for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setImmediate(resolve));
    expect(started).toBe(true);
    if (settled) {
      resolvePrompt({ stopReason: 'end_turn' });
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    }
    proc.kill();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    if (settled) {
      // A settled end_turn completes cleanly; killing the native afterwards does not
      // manufacture a transport error.
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    } else {
      expect(events.at(-1)).toMatchObject({ type: 'execution_error', category: 'transport', recoverable: true });
    }
    await collection;
  } finally {
    await session.dispose();
    await collection;
    native.dispose();
  }
});
