import { exec } from 'node:child_process';

import { BangBashService } from '@/features/chat/input/BangBashService';

jest.mock('node:child_process', () => ({ exec: jest.fn() }));

const execMock = exec as unknown as jest.Mock;

function respond(error: unknown, stdout: string | null, stderr: string | null): void {
  execMock.mockImplementation((
    _command: string,
    _options: unknown,
    callback: (error: unknown, stdout: string | null, stderr: string | null) => void,
  ) => {
    callback(error, stdout, stderr);
  });
}

describe('BangBashService', () => {
  let service: BangBashService;

  beforeEach(() => {
    service = new BangBashService('/test/vault', '/usr/bin:/usr/local/bin');
  });

  afterEach(() => {
    execMock.mockReset();
  });

  it('runs the command in the vault with the enhanced PATH and a bounded budget', async () => {
    respond(null, '', '');

    await service.execute('echo hello');

    expect(execMock).toHaveBeenCalledWith(
      'echo hello',
      expect.objectContaining({
        cwd: '/test/vault',
        env: expect.objectContaining({ PATH: '/usr/bin:/usr/local/bin' }),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }),
      expect.any(Function),
    );
  });

  it('returns stdout and exit code 0 for a successful command', async () => {
    respond(null, 'hello\n', '');

    const result = await service.execute('echo hello');

    expect(result.command).toBe('echo hello');
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
  });

  it('keeps stderr and the reported exit code for a failing command', async () => {
    respond(Object.assign(new Error('Command failed'), { code: 2 }), '', 'No such file\n');

    const result = await service.execute('ls /nonexistent');

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('No such file\n');
    expect(result.failure).toBeUndefined();
  });

  it('reports exit code 1 when the failure carries no numeric code', async () => {
    respond(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), '', '');

    const result = await service.execute('missing-binary');

    expect(result.exitCode).toBe(1);
  });

  it('reports a killed command as a timeout', async () => {
    respond(Object.assign(new Error('Timed out'), { killed: true }), '', '');

    const result = await service.execute('sleep 999');

    expect(result.exitCode).toBe(124);
    expect(result.failure).toBe('timeout');
  });

  it('keeps partial output when the buffer limit kills the command', async () => {
    respond(
      Object.assign(new Error('maxBuffer'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
      'partial output',
      '',
    );

    const result = await service.execute('cat /dev/urandom');

    expect(result.exitCode).toBe(124);
    expect(result.failure).toBe('outputLimit');
    expect(result.stdout).toBe('partial output');
  });

  it('treats missing stdout and stderr as empty', async () => {
    respond(null, null, null);

    const result = await service.execute('true');

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
