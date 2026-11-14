import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplication } from "../src/index.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

test("ordinary functions run independently and retain typed outcomes until explicitly forgotten", async () => {
  const app = createApplication();
  const hold = gate();
  const slow = app.start(async () => { await hold.wait; return 42; });
  const fast = app.start(() => "ready");
  assert.deepEqual(await fast.done, { status: "succeeded", value: "ready" });
  assert.equal(slow.state.status, "running");
  assert.equal(app.list().length, 2);
  assert.throws(() => app.forget(slow), /before it settles/);
  hold.release();
  assert.deepEqual(await slow.done, { status: "succeeded", value: 42 });
  assert.equal(app.forget(slow), true);
  assert.equal(app.forget(slow), false);
  assert.deepEqual(await slow.done, { status: "succeeded", value: 42 });
});

test("cancellation is a request, not premature settlement", async () => {
  const app = createApplication();
  const hold = gate();
  const started = gate();
  const run = app.start(async ({ signal }) => {
    started.release();
    await hold.wait;
    signal.throwIfAborted();
    return "unreachable";
  });
  await started.wait;
  assert.equal(run.cancel(), true);
  assert.equal(run.cancel(), false);
  assert.equal(run.state.status, "cancelling");
  hold.release();
  assert.equal((await run.done).status, "cancelled");
  assert.equal(run.cancel(), false);
});

test("ignored cancellation can succeed; unrelated errors remain failures", async () => {
  const app = createApplication();
  const hold = gate();
  const failure = new Error("independent bug");
  const ignored = app.start(async () => { await hold.wait; return 7; });
  const broken = app.start(async () => { await hold.wait; throw failure; });
  await Promise.resolve();
  ignored.cancel();
  broken.cancel();
  hold.release();
  assert.deepEqual(await ignored.done, { status: "succeeded", value: 7 });
  assert.deepEqual(await broken.done, { status: "failed", error: failure });
});

test("pre-start cancellation skips work; synchronous exceptions become observed outcomes", async () => {
  const app = createApplication();
  let called = false;
  const cancelled = app.start(() => { called = true; });
  cancelled.cancel("stop");
  assert.deepEqual(await cancelled.done, { status: "cancelled", reason: "stop" });
  assert.equal(called, false);
  const error = new Error("failed");
  assert.deepEqual(await app.start(() => { throw error; }).done, { status: "failed", error });
});

test("cancellation preserves non-reflexive primitive reasons", async () => {
  const app = createApplication();
  const run = app.start(() => "not reached");
  run.cancel(Number.NaN);
  assert.deepEqual(await run.done, { status: "cancelled", reason: Number.NaN });
});

test("run identity cannot be confused across applications", async () => {
  const left = createApplication();
  const right = createApplication();
  const a = left.start(() => 1);
  const b = right.start(() => 2);
  await Promise.all([a.done, b.done]);
  assert.equal(a.id, b.id);
  assert.equal(left.forget(b), false);
  assert.equal(left.list()[0], a);
  assert.equal(Object.isFrozen(a.state), true);
  assert.equal(Object.isFrozen(left.list()), true);
});
