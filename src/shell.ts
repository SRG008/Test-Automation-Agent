import { spawn } from 'child_process';

export interface CommandResult {
  code: number;
  output: string;
}

const MAX_OUTPUT = 12000;

// Runs a full command line, such as a repo's "npm test", through the system shell.
export function runCommandLine(commandLine: string, cwd: string, timeoutMs = 600_000, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(commandLine, { cwd, shell: true, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: output.slice(-MAX_OUTPUT) });
    });
  });
}

// Runs a command in cwd and resolves with its exit code and the tail of its combined output.
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise(resolve => {
    const onWindows = process.platform === 'win32';
    // With shell: true on Windows, a path containing spaces must be quoted.
    const exe = onWindows && command.includes(' ') ? `"${command}"` : command;
    const child = spawn(exe, args, { cwd, shell: onWindows, windowsHide: true, env: env ? { ...process.env, ...env } : undefined });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT * 4) output = output.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(err) });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: output.slice(-MAX_OUTPUT) });
    });
  });
}
