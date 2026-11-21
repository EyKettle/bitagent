import assert from "node:assert/strict";
import { test } from "node:test";
import { Job } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob } from "@bitagent/core/host";

import { gate } from "./fixtures/control.mjs";

async function cleanupRethrow(t, cleanupError, handler) {
  const root = createExecutionRoot();
  t.after(() => root.close().catch(() => {}));
  const childStarted = gate();
  const parentStarted = gate();
  let child;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.spawn(function* () {
      try {
        yield* fromAsync((signal) => new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          childStarted.release();
        }));
      } finally { throw cleanupError; }
    });
    yield* fromAsync(() => childStarted.promise);
    try {
      yield* fromAsync((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        parentStarted.release();
      }));
    } finally {
      try { yield* child.wait(); }
      catch (error) {
        assert.ok(Object.is(error, cleanupError));
        yield* handler(error);
        throw error;
      }
    }
  }));
  await parentStarted.promise;
  const closing = root.close("B1 regression");
  // Observe rejection immediately, including literal undefined failures.
  const closeOutcome = closing.then(
    () => ({ state: "finished" }),
    (error) => ({ state: "failed", error }),
  );
  const outcome = await waitForJob(parent);
  const closed = await closeOutcome;
  assert.equal(child.outcome.state, "failed");
  assert.ok(Object.is(child.outcome.error, cleanupError));
  assert.equal(outcome.state, "failed");
  assert.equal(closed.state, "failed");
  assert.equal(root.state, "closed");
  assert.equal(root.close(), closing);
  return { outcome, closed };
}

const singleFailures = [
  ["Error", new Error("one cleanup failure")],
  ["undefined", undefined],
  ["NaN", Number.NaN],
  ["negative zero", -0],
  ["AggregateError", new AggregateError([new Error("original member")], "original aggregate")],
];
for (const [label, error] of singleFailures) {
  test(`one ${label} cleanup failure keeps its identity after protected suspensions`, { timeout: 5000 }, async (t) => {
    let protectedCalls = 0;
    const { outcome, closed } = await cleanupRethrow(t, error, function* () {
      for (let i = 0; i < 2; i++) {
        yield* fromAsync(async (signal) => {
          assert.equal(signal.aborted, false);
          protectedCalls++;
          await Promise.resolve();
        });
      }
    });
    assert.equal(protectedCalls, 2);
    assert.ok(Object.is(outcome.error, error));
    assert.ok(Object.is(closed.error, error));
  });
}

test("a handled different Host error does not erase an earlier wait failure", { timeout: 5000 }, async (t) => {
  const original = new Error("child cleanup");
  const handled = new Error("handled Host cleanup");
  let handledCalls = 0;
  const { outcome, closed } = await cleanupRethrow(t, original, function* () {
    try { yield* fromAsync(() => { throw handled; }); }
    catch (error) { assert.equal(error, handled); handledCalls++; }
    yield* fromAsync((signal) => { assert.equal(signal.aborted, false); });
  });
  assert.equal(handledCalls, 1);
  assert.equal(outcome.error, original);
  assert.equal(closed.error, original);
});

test("a new Host rejection equal to a waited cleanup error remains an independent failure", { timeout: 5000 }, async (t) => {
  const error = new Error("equal values, independent child and Host failures");
  const { outcome, closed } = await cleanupRethrow(t, error, function* () {
    yield* fromAsync(() => { throw error; });
  });
  assert.ok(outcome.error instanceof AggregateError);
  assert.deepEqual(outcome.error.errors, [error, error]);
  assert.ok(closed.error instanceof AggregateError);
  assert.deepEqual(closed.error.errors, [error, error]);
});

test("independent equal child failures remain two sources after wait and delayed rethrow", { timeout: 5000 }, async (t) => {
  const root = createExecutionRoot();
  t.after(() => root.close().catch(() => {}));
  const started = [gate(), gate()];
  const parentStarted = gate();
  const error = new Error("two independent child cleanups");
  const parent = root.run(() => Job.spawn(function* () {
    const children = started.map((entry) => Job.spawn(function* () {
      try {
        yield* fromAsync((signal) => new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          entry.release();
        }));
      } finally { throw error; }
    }));
    yield* fromAsync(() => Promise.all(started.map((entry) => entry.promise)));
    try {
      yield* fromAsync((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        parentStarted.release();
      }));
    } finally {
      for (const child of children) {
        try { yield* child.wait(); }
        catch (caught) { assert.equal(caught, error); }
      }
      yield* fromAsync((signal) => { assert.equal(signal.aborted, false); });
      throw error;
    }
  }));
  await parentStarted.promise;
  const closing = root.close();
  const observedClose = closing.catch((error) => error);
  const outcome = await waitForJob(parent);
  assert.equal(outcome.state, "failed");
  assert.ok(outcome.error instanceof AggregateError);
  assert.deepEqual(outcome.error.errors, [error, error]);
  const rootError = await observedClose;
  assert.ok(rootError instanceof AggregateError);
  assert.deepEqual(rootError.errors, [error, error]);
  assert.equal(root.state, "closed");
});

test("a child aggregate keeps its identity across a later protected suspension", { timeout: 5000 }, async (t) => {
  const root = createExecutionRoot();
  const grandchildStarted = gate();
  const cleaning = gate();
  const finishCleanup = gate();
  const bodyError = new Error("child body failure");
  const cleanupError = new Error("grandchild cleanup failure");
  t.after(async () => {
    finishCleanup.release();
    await root.close().catch(() => {});
  });
  let child;
  let originalAggregate;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.spawn(function* () {
      Job.spawn(function* () {
        try {
          yield* fromAsync((signal) => new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            grandchildStarted.release();
          }));
        } finally {
          yield* fromAsync(() => { cleaning.release(); return finishCleanup.promise; });
          throw cleanupError;
        }
      });
      yield* fromAsync(() => grandchildStarted.promise);
      throw bodyError;
    });
    try { yield* child.wait(); }
    finally {
      try { yield* child.wait(); }
      catch (error) {
        originalAggregate = error;
        yield* fromAsync((signal) => { assert.equal(signal.aborted, false); });
        throw error;
      }
    }
  }));
  await cleaning.promise;
  const closing = root.close();
  const observedClose = closing.catch((error) => error);
  assert.equal(parent.outcome, undefined);
  finishCleanup.release();
  const outcome = await waitForJob(parent);
  assert.equal(outcome.state, "failed");
  assert.ok(originalAggregate instanceof AggregateError);
  assert.deepEqual(originalAggregate.errors, [bodyError, cleanupError]);
  assert.equal(child.outcome.error, originalAggregate);
  assert.equal(outcome.error, originalAggregate);
  const rootError = await observedClose;
  assert.ok(rootError instanceof AggregateError);
  assert.deepEqual(rootError.errors, [bodyError, cleanupError]);
});
