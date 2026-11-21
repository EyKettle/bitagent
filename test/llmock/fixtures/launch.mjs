import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Starts and closes only this test's loopback server; never kills a listener by port. */
export async function launchMock(t, model = "bitagent") {
  const child = fork(fileURLToPath(new URL("../../../dev/llmock/server.mjs", import.meta.url)), ["--port", "0", "--model", model], {
    execArgv: ["--import", "tsx"], silent: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  t.after(async () => {
    if (child.connected) child.send("stop", () => {});
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const result = await exited;
      assert.deepEqual(result, { code: 0, signal: null }, output);
      t.diagnostic(JSON.stringify({ model, childExit: result }));
    } finally { clearTimeout(timeout); }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Mock startup timed out: " + output));
    }, 10000);
    const onMessage = (message) => {
      if (message?.type !== "ready" || typeof message.url !== "string") return;
      cleanup();
      resolve(message.url);
    };
    const onExit = (code) => { cleanup(); reject(new Error("Mock exited: " + code + "\n" + output)); };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
