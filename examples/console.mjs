import { createInterface } from "node:readline";
import { Recoverable } from "node:repl";
import { inspect, parseArgs } from "node:util";
import { createApplication } from "@bitagent/core";
import { createScriptConsole, ScriptCompileError } from "@bitagent/core/node";
import { createMockLlm } from "./mock-llm.mjs";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:4317/v1" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});
const help = ".help lists commands; .break discards unfinished input; .clear resets definitions; .exit cancels managed work and waits.";

if (values.help) {
  console.log("Usage: node examples/console.mjs [--base-url http://127.0.0.1:4317/v1]");
  console.log(help);
} else {
  const app = createApplication();
  const scripts = await createScriptConsole({ app, llm: createMockLlm(values["base-url"]) });
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const terminal = createInterface({
    input: process.stdin, output: process.stdout, terminal: interactive, crlfDelay: Infinity,
  });
  let closed = false;
  let interrupted = false;
  let pending = "";
  const reason = new Error("Console closed");
  const cancelWork = () => { for (const run of app.list()) run.cancel(reason); };
  const interrupt = () => {
    interrupted = true;
    cancelWork();
    terminal.close();
  };
  terminal.once("close", () => { closed = true; });
  terminal.once("SIGINT", interrupt);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const prompt = () => {
    if (!interactive || closed) return;
    terminal.setPrompt(pending === "" ? "bitagent> " : "... ");
    terminal.prompt();
  };
  console.log("BitAgent — trusted TypeScript; app and llm are available.");
  console.log(help);
  prompt();

  try {
    for await (const line of terminal) {
      if (interrupted) break;
      const command = line.trim();
      if (command === ".exit") { pending = ""; break; }
      if (command === ".break") pending = "";
      else if (pending === "" && command === ".help") console.log(help);
      else if (pending === "" && command === ".clear") await scripts.reset();
      else {
        pending += line + "\n";
        try {
          const { value } = await scripts.evaluate(pending);
          if (value !== undefined) console.log(inspect(value, { colors: interactive }));
          pending = "";
        } catch (error) {
          if (!(error instanceof Recoverable)) {
            console.log(error instanceof ScriptCompileError ? error.message : inspect(error));
            pending = "";
          }
        }
      }
      prompt();
    }
    if (!interrupted && pending.trim() !== "") {
      console.error("Input ended with an incomplete TypeScript snippet.");
      process.exitCode = 1;
    }
  } finally {
    terminal.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    cancelWork();
    await Promise.all(app.list().map((run) => run.done));
  }
}
