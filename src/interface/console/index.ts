import { createInterface } from "node:readline";
import { inspect, parseArgs, types } from "node:util";

import { Application } from "../../context/application/index.js";
import type { ScriptFile } from "../../context/application/index.js";
import type { ExecutionResult } from "../../runtime/compiler/index.js";

const commands = [
  "Enter one line of TypeScript to submit it.",
  ".file PATH   Read a TypeScript file without executing it.",
  ".run         Execute the acquired file in this application.",
  ".drop NAME   Remove a definition from application scope.",
  ".help        Show these commands. Ctrl-D exits.",
].join("\n");

function show(result: ExecutionResult): void {
  switch (result.kind) {
    case "success":
      if (result.hasValue) console.log(inspect(result.value, { customInspect: false }));
      break;
    case "diagnostic":
      for (const diagnostic of result.diagnostics) {
        const location = diagnostic.fileName ? ` ${diagnostic.fileName}:${diagnostic.line}:${diagnostic.column}` : "";
        console.error(`${diagnostic.kind} TS${diagnostic.code}${location}: ${diagnostic.message}`);
      }
      break;
    case "execution-error":
      showError(result.error);
      break;
  }
}

function showError(error: unknown): void {
  const description = types.isNativeError(error)
    ? `${error.name}: ${error.message}`
    : inspect(error, { customInspect: false });
  console.error(`Execution error: ${description}`);
}

class Console {
  readonly #application: Application;
  #file?: ScriptFile;

  constructor(application: Application) {
    this.#application = application;
  }

  async submit(source: string): Promise<void> {
    const line = source.trim();
    if (!line) return;
    const separator = line.search(/\s/u);
    const command = separator < 0 ? line : line.slice(0, separator);
    const argument = separator < 0 ? "" : line.slice(separator).trimStart();
    switch (command) {
      case ".file":
        await this.#acquire(argument);
        break;
      case ".run":
        if (argument) console.error("Usage: .run");
        else if (!this.#file) console.error("No file acquired; use .file PATH first");
        else show(await this.#application.runFile(this.#file));
        break;
      case ".drop":
        if (!argument || /\s/u.test(argument)) console.error("Usage: .drop NAME");
        else if (await this.#application.drop(argument)) console.log(`Dropped ${argument}`);
        else console.error(`Definition not found: ${argument}`);
        break;
      case ".help":
        console.log(commands);
        break;
      default:
        show(await this.#application.submit(source));
    }
  }

  async #acquire(path: string): Promise<void> {
    this.#file = undefined;
    if (!path) {
      console.error("Usage: .file PATH");
      return;
    }
    try {
      this.#file = await this.#application.acquireFile(path);
      console.log(`Acquired ${this.#file.fileName}`);
    } catch (error) {
      showError(error);
    }
  }
}

async function runConsole(): Promise<void> {
  const { values } = parseArgs({ options: { workspace: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log(`Usage: pnpm start [--workspace DIRECTORY]\n\n${commands}`);
    return;
  }
  const session = new Console(new Application({ workspace: values.workspace }));
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal, prompt: "bit> " });
  if (terminal) lines.prompt();
  for await (const source of lines) {
    await session.submit(source);
    if (terminal) lines.prompt();
  }
}

try {
  await runConsole();
} catch (error) {
  showError(error);
  process.exitCode = 1;
}
