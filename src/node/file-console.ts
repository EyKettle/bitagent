import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { inspect } from "node:util";
import type { FileSession } from "./file-session.js";

export interface FileConsoleOptions {
  readonly session: FileSession;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly signal?: AbortSignal;
}

const help = [
  ".run <path>  Check and execute a TypeScript file in this instance (the rest of the line is the path).",
  ".clear       Forget live names; captured references and application tasks remain.",
  ".help        Show these commands.",
  ".exit        Disconnect this console; the host owns task and session shutdown.",
  "Short TypeScript expressions also work: app.list(), job.state, job.cancel(), scope.list().",
  "Write multi-line work in your editor; start function* coroutines with app.start().",
].join("\n");

/** Host I/O only: command admission never joins application tasks. The caller owns shutdown. */
export async function runFileConsole(options: FileConsoleOptions): Promise<void> {
  const { session, input = process.stdin, output = process.stdout, signal } = options;
  if (signal?.aborted) return;
  const interactive = Boolean("isTTY" in input && input.isTTY && "isTTY" in output && output.isTTY);
  const terminal = createInterface({ input, output, terminal: interactive, crlfDelay: Infinity });
  let closed = false;
  const disconnect = () => terminal.close();
  terminal.once("close", () => { closed = true; });
  terminal.once("SIGINT", disconnect);
  signal?.addEventListener("abort", disconnect, { once: true });
  const write = (text: string) => { output.write(text + "\n"); };
  const prompt = () => { if (interactive && !closed) { terminal.setPrompt("bitagent> "); terminal.prompt(); } };
  write(`BitAgent file session: ${session.cwd}`);
  write(`Editor declarations: ${session.declarationsPath}`);
  write(help);
  prompt();
  try {
    for await (const line of terminal) {
      if (signal?.aborted) break;
      const command = line.trim();
      if (command === ".exit") break;
      try {
        if (command === ".help") write(help);
        else if (command === ".clear") session.scope.clear();
        else if (command !== "") {
          let result;
          if (command === ".run" || /^\.run\s/.test(command)) {
            const path = command.slice(4).trim();
            if (path === "") throw new Error("Usage: .run <path>");
            result = session.runFile(path);
          } else {
            result = session.evaluate(line);
          }
          if (result.value !== undefined) write(inspect(result.value, { colors: interactive }));
        }
      } catch (error) {
        write(error instanceof Error ? error.message : inspect(error));
      }
      prompt();
    }
  } finally {
    signal?.removeEventListener("abort", disconnect);
    terminal.close();
  }
}
