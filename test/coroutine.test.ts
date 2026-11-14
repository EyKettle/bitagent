import assert from "node:assert/strict";
import { test } from "node:test";
import { createScheduler, type Coroutine } from "../src/index.js";
import { fromAsync, waitForTask } from "../src/host.js";

function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

test("a suspended coroutine leaves the instance available and resumes in sequence", async () => {
  const app = createScheduler();
  const hold = gate<number>();
  const events: string[] = [];
  const a = app.start(function* (): Coroutine<number> {
    events.push("before");
    const value = yield* fromAsync(() => hold.promise);
    events.push("after");
    return value + 1;
  });
  const b = app.start(function* () { events.push("control"); return a.state.status; });
  assert.deepEqual(await waitForTask(b), { status: "succeeded", value: "waiting" });
  assert.deepEqual(events, ["before", "control"]);
  assert.equal("then" in a, false);
  assert.equal("done" in a, false);
  hold.release(41);
  assert.deepEqual(await waitForTask(a), { status: "succeeded", value: 42 });
  assert.deepEqual(events, ["before", "control", "after"]);
});

test("joining a task observes its committed terminal state and typed result", async () => {
  const app = createScheduler();
  const hold = gate<string>();
  const target = app.start(function* () { return yield* fromAsync(() => hold.promise); });
  const waiter = app.start(function* () {
    const value = yield* target.join();
    assert.deepEqual(target.state, { status: "succeeded", value: "ready" });
    return value.length;
  });
  hold.release("ready");
  assert.deepEqual(await waitForTask(waiter), { status: "succeeded", value: 5 });
  assert.equal(app.forget(target), true);
  assert.equal(app.forget(target), false);
  assert.deepEqual(await waitForTask(target), { status: "succeeded", value: "ready" });
});

test("cancellation joins pending I/O before unwinding the coroutine", async () => {
  const app = createScheduler();
  const hold = gate<void>();
  const begun = gate<void>();
  let unwound = false;
  let passedWait = false;
  const task = app.start(function* () {
    try {
      yield* fromAsync(() => { begun.release(); return hold.promise; });
      passedWait = true;
    } finally { unwound = true; }
  });
  await begun.promise;
  assert.equal(task.cancel(Number.NaN), true);
  assert.equal(task.state.status, "cancelling");
  assert.equal(unwound, false);
  assert.equal(task.cancel(), false);
  assert.throws(() => app.forget(task), /before it settles/);
  hold.release();
  assert.deepEqual(await waitForTask(task), { status: "cancelled", reason: Number.NaN });
  assert.equal(unwound, true);
  assert.equal(passedWait, false);
});

test("cancelling a joiner does not cancel its target", async () => {
  const app = createScheduler();
  const hold = gate<number>();
  const target = app.start(function* () { return yield* fromAsync(() => hold.promise); });
  const waiter = app.start(function* () { return yield* target.join(); });
  await Promise.resolve();
  waiter.cancel("stop waiting");
  assert.deepEqual(await waitForTask(waiter), { status: "cancelled", reason: "stop waiting" });
  assert.equal(target.state.status, "waiting");
  hold.release(3);
  assert.deepEqual(await waitForTask(target), { status: "succeeded", value: 3 });
});

test("operation failures enter generator catch; unrelated cancellation failures stay failures", async () => {
  const app = createScheduler();
  const failure = new Error("I/O failed");
  const recovered = app.start(function* () {
    try { yield* fromAsync(() => { throw failure; }); }
    catch (error) { assert.equal(error, failure); return "recovered"; }
    return "unreachable";
  });
  assert.deepEqual(await waitForTask(recovered), { status: "succeeded", value: "recovered" });
  const hold = gate<void>();
  const broken = app.start(function* () {
    try { yield* fromAsync(() => hold.promise); }
    finally { throw failure; }
  });
  await Promise.resolve();
  broken.cancel("cancel");
  hold.release();
  assert.deepEqual(await waitForTask(broken), { status: "failed", error: failure });
});

test("queued cancellation skips work and task ownership is checked by identity", async () => {
  const app = createScheduler();
  let called = false;
  const task = app.start(function* () { called = true; return 1; });
  task.cancel("before start");
  assert.deepEqual(await waitForTask(task), { status: "cancelled", reason: "before start" });
  assert.equal(called, false);
  const other = createScheduler().start(function* () { return 2; });
  await waitForTask(other);
  assert.equal(task.id, other.id);
  assert.equal(app.forget(other), false);
});

test("invalid suspensions unwind the generator instead of skipping cleanup", async () => {
  const app = createScheduler();
  let cleaned = false;
  const task = app.start(function* (): Coroutine<void> {
    try {
      // @ts-expect-error exercises the runtime boundary for untyped callers
      yield {};
    } finally { cleaned = true; }
  });
  const outcome = await waitForTask(task);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(String(outcome.error), /unknown suspension/);
  assert.equal(cleaned, true);
});

test("async generators are rejected rather than driven as synchronous iterators", async () => {
  const app = createScheduler();
  // @ts-expect-error exercises the untyped host boundary
  const task = app.start(async function* () { return 1; });
  const outcome = await waitForTask(task);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(String(outcome.error), /must return a coroutine/);
});

// Compile-time checks are deliberately never executed.
function typeContract() {
  const app = createScheduler();
  // @ts-expect-error user work is a coroutine, not an async function
  app.start(async () => 42);
  const task = app.start(function* () { return 42; });
  // @ts-expect-error handles expose no Promise
  task.then;
  // @ts-expect-error handles expose no asynchronous completion field
  task.done;
}
void typeContract;
