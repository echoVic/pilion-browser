/**
 * 预期内的用户错误（用法错、文件已存在等）：只打印 message，不打堆栈。
 * silent：命令已经把结果（含失败）完整打印过了，只需要非零退出码，不再追加一份错误文档。
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly silent = false,
  ) {
    super(message);
  }
}

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/** --json 时打印紧凑 JSON（单行），否则打印人类可读文本（text 为空串时什么都不打）。 */
export function printResult(io: CliIo, json: boolean, value: unknown, text: string): void {
  if (json) io.stdout(JSON.stringify(value));
  else if (text) io.stdout(text);
}

/** 统一错误出口：--json 时 stdout 一行 {error}，否则 stderr。 */
export function printError(io: CliIo, json: boolean, message: string): void {
  if (json) io.stdout(JSON.stringify({ error: message }));
  else io.stderr(message);
}
