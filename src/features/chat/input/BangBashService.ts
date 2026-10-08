import { exec } from 'node:child_process';

/** Outcome of one composer bash command. */
export interface BangBashResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the shell was stopped before the command exited on its own. */
  failure?: 'timeout' | 'outputLimit';
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Conventional exit status for a command killed by a deadline. */
const KILLED_EXIT_CODE = 124;

/**
 * Runs one composer bash command in the vault through the user's own shell.
 * The command is killed after the timeout and its output is capped, so a
 * runaway command cannot hang the composer or exhaust the transcript.
 */
export class BangBashService {
  constructor(
    private readonly cwd: string,
    private readonly path: string,
  ) {}

  execute(command: string): Promise<BangBashResult> {
    return new Promise((resolve) => {
      exec(command, {
        cwd: this.cwd,
        env: { ...process.env, PATH: this.path },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
      }, (error, stdout, stderr) => {
        if (error && error.killed) {
          // Node types `code` as number, but a maxBuffer kill reports the
          // ERR_CHILD_PROCESS_STDIO_MAXBUFFER string at runtime.
          resolve({
            command,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: KILLED_EXIT_CODE,
            failure: String(error.code) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'outputLimit'
              : 'timeout',
          });
          return;
        }

        resolve({
          command,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        });
      });
    });
  }
}
