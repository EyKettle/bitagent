import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import ts from "typescript";
import { Job, JobCancelledError } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob } from "@bitagent/core/host";

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test("built package joins actual socket closure, host cleanup, catch and finally before terminal publication", { timeout: 10000 }, async (t) => {
  const root = createExecutionRoot();
  const received = gate();
  const peerClosed = gate();
  const entered = gate();
  const resourcesClosed = gate();
  const operationCleanup = gate();
  const caught = gate();
  const handler = gate();
  const cleaning = gate();
  const cleanup = gate();
  const events = [];
  const peers = new Set();
  const server = createServer((socket) => {
    peers.add(socket);
    socket.once("data", (data) => {
      assert.equal(data.toString(), "controlled runtime");
      events.push("peer-received");
      received.release();
    });
    socket.once("close", () => { peers.delete(socket); peerClosed.release(); });
  });
  let socket;
  t.after(async () => {
    operationCleanup.release();
    handler.release();
    cleanup.release();
    socket?.destroy();
    for (const peer of peers) peer.destroy();
    await root.close();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  let abortedSignal;
  const reason = { request: "public acceptance" };
  const job = root.run(() => Job.create(function* () {
    try {
      yield* fromAsync(async (signal) => {
        abortedSignal = signal;
        const stopped = gate();
        socket = createConnection({ host: "127.0.0.1", port: address.port });
        const closed = once(socket, "close");
        const abort = () => { events.push("abort"); socket.destroy(); stopped.release(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await once(socket, "connect");
          events.push("socket-connected");
          socket.write("controlled runtime");
          await received.promise;
          entered.release();
          await stopped.promise;
        } finally {
          signal.removeEventListener("abort", abort);
          socket.destroy();
          await Promise.all([closed, peerClosed.promise]);
          events.push("resources-closed");
          resourcesClosed.release();
          await operationCleanup.promise;
          events.push("operation-cleaned");
        }
        signal.throwIfAborted();
      });
      assert.fail("cancelled operation continued normally");
    } catch (error) {
      assert.equal(error, abortedSignal.reason);
      assert.ok(error instanceof JobCancelledError);
      assert.equal(error.reason, reason);
      events.push("native-catch");
      yield* fromAsync(async (signal) => {
        assert.equal(signal.aborted, false);
        caught.release();
        await handler.promise;
        events.push("handler-cleaned");
      });
    } finally {
      yield* fromAsync(async (signal) => {
        assert.equal(signal.aborted, false);
        events.push("native-finally");
        cleaning.release();
        await cleanup.promise;
        events.push("finally-cleaned");
      });
    }
    return 42;
  }));
  const observation = waitForJob(job);
  await setImmediate();
  assert.equal(job.state, "created");
  assert.deepEqual(events, []);
  assert.equal(job.start(), true);
  assert.deepEqual(events, []);
  await entered.promise;
  assert.equal(job.cancel(reason), true);
  assert.equal(abortedSignal.aborted, true);
  assert.equal(job.outcome, undefined);
  const control = root.run(() => Job.spawn(function* () { return job.state; }));
  assert.deepEqual(await waitForJob(control), { state: "finished", value: "cancelling" });
  const closing = root.close("root shutdown");
  assert.equal(root.close(), closing);
  await resourcesClosed.promise;
  assert.equal(socket.destroyed, true);
  assert.equal(job.outcome, undefined);
  assert.equal(root.state, "closing");
  assert.equal(events.includes("native-catch"), false);
  operationCleanup.release();
  await caught.promise;
  assert.equal(job.outcome, undefined);
  handler.release();
  await cleaning.promise;
  assert.equal(job.outcome, undefined);
  assert.equal(root.state, "closing");
  cleanup.release();
  assert.deepEqual(await observation, { state: "cancelled", reason });
  events.push("terminal-observed");
  await closing;
  events.push("root-closed");
  assert.equal(root.state, "closed");
  assert.deepEqual(events, [
    "socket-connected", "peer-received", "abort", "resources-closed", "operation-cleaned",
    "native-catch", "handler-cleaned", "native-finally", "finally-cleaned", "terminal-observed", "root-closed",
  ]);
  t.diagnostic(JSON.stringify(events));
});

test("built public declarations preserve Core and Host types without exposing the kernel", () => {
  const fixture = fileURLToPath(new URL("../dev/fixtures/runtime-consumer.ts", import.meta.url));
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
  const exposedKernelFiles = program.getSourceFiles().filter((source) => /[/\\]node_modules[/\\]effection[/\\]/.test(source.fileName));
  assert.deepEqual(exposedKernelFiles.map((source) => source.fileName), []);
});
