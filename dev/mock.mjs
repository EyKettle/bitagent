import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "llmock";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4317" },
    model: { type: "string", default: "bitagent" },
  },
  allowPositionals: false,
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError("port must be an integer between 0 and 65535");
}

// This standalone development process never persists LLMock's database.
process.env.MOCK_DB_PERSIST = "OFF";
const server = await startServer({
  config: fileURLToPath(new URL("./llmock.json", import.meta.url)),
  port,
  model: values.model,
  host: "127.0.0.1",
  settings: { admin: false, logRequests: false, debug: false },
});

let closing;
function stop() {
  closing ??= server.close().finally(() => {
    if (process.connected) process.disconnect();
  });
  closing.catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("disconnect", stop);
process.on("message", (message) => { if (message === "stop") stop(); });
if (process.send) process.send({ type: "ready", url: server.url });
else console.log("LLMock ready at " + server.url + " — Ctrl+C to stop.");
