import { createInterface } from "node:readline";
import { inspect, types } from "node:util";

import { Application } from "../../context/application/index.js";
import type { ExecutionResult } from "../../runtime/compiler/index.js";

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

async function runConsole(): Promise<void> {
  const application = new Application();
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal, prompt: "bit> " });
  if (terminal) lines.prompt();
  for await (const source of lines) {
    if (source.trim()) show(await application.submit(source));
    if (terminal) lines.prompt();
  }
}

try {
  await runConsole();
} catch (error) {
  showError(error);
  process.exitCode = 1;
}
