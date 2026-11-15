import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createScheduler } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { createFileSession, initializeFileWorkspace, runFileConsole } from "@bitagent/core/node";
import { createMockEntity } from "./mock-entity.mjs";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:4318" },
    cwd: { type: "string", default: fileURLToPath(new URL("./workspace/", import.meta.url)) },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log("Usage: node examples/console.mjs [--cwd directory] [--base-url http://127.0.0.1:4318]");
  console.log("Edit TypeScript files, then use .run <path> in this live instance.");
  console.log("The default workspace is examples/workspace. Existing tsconfig.json files are never overwritten.");
  console.log(".exit, EOF and signals cancel managed tasks and wait for cooperative cleanup; the separate mock server stays running.");
} else {
  const app = createScheduler();
  const llm = createMockEntity(values["base-url"]);
  initializeFileWorkspace(values.cwd);
  const session = createFileSession({ app, llm, cwd: values.cwd });
  const input = new AbortController();
  const reason = new Error("Console closed");
  const interrupt = () => {
    input.abort(reason);
    for (const task of app.list()) task.cancel(reason);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  console.log("Host shutdown: .exit cancels managed tasks and waits for cooperative cleanup.");
  try {
    await runFileConsole({ session, signal: input.signal });
  } finally {
    interrupt();
    try {
      await Promise.all(app.list().map((task) => waitForTask(task)));
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      session.close();
    }
  }
}
