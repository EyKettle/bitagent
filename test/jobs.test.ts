import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Job, JobCancelledError, JobStateError, type Coroutine } from "../src/index.js";
import { createExecutionRoot, fromAsync, waitForJob } from "../src/host.js";

function gate<T = void>() {
  let release!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { release = done; reject = fail; });
  return { promise, release, reject };
}

function failure(outcome: Awaited<ReturnType<typeof waitForJob>>): unknown {
  assert.equal(outcome.state, "failed");
  if (outcome.state !== "failed") throw new Error("Expected failure");
  return outcome.error;
}

test("roots enter synchronously, isolate context and restore it on return and throw", async () => {
  const a = createExecutionRoot();
  const b = createExecutionRoot();
  const original = new Error("entry failed");
  assert.throws(() => Job.create(function* () {}), TypeError);
  assert.equal(a.state, "open");
  assert.equal(a.run(() => a.run(() => 42)), 42);
  a.run(() => assert.throws(() => b.run(() => assert.fail("must not enter")), TypeError));
  assert.throws(() => a.run(() => { throw original; }), (error) => error === original);
  assert.throws(() => Job.create(function* () {}), TypeError);
  // @ts-expect-error host entry is synchronously scoped
  assert.throws(() => a.run(async () => 1), TypeError);
  let escaped!: Promise<void>;
  a.run(() => { escaped = Promise.resolve().then(() => { assert.throws(() => Job.create(function* () {}), TypeError); }); });
  await escaped;
  await Promise.all([a.close(), b.close()]);
});

test("Jobs create without entry, start once, and expose committed values without cloning", async () => {
  const root = createExecutionRoot();
  const object = { success: false, value: 3 };
  let entered = false;
  const job = root.run(() => Job.create(function* () { entered = true; return object; }));
  assert.equal(job.state, "created");
  assert.equal(job.outcome, undefined);
  assert.equal("then" in job, false);
  assert.equal("done" in job, false);
  assert.throws(() => job.result, (error) => error instanceof JobStateError && error.state === "created");
  const observation = waitForJob(job);
  await setImmediate();
  assert.equal(job.state, "created");
  assert.equal(job.start(), true);
  assert.equal(entered, false);
  assert.equal(job.state, "generating");
  assert.throws(() => job.result, JobStateError);
  assert.equal(job.start(), false);
  const outcome = await observation;
  assert.equal(outcome, job.outcome);
  assert.deepEqual(outcome, { state: "finished", value: object });
  assert.equal(job.result, object);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(job.start(), false);
  assert.equal(job.cancel(), false);
  await root.close();
});

test("spawn delays business entry and queued cancellation skips the body", async () => {
  const root = createExecutionRoot();
  let entered = false;
  const job = root.run(() => Job.spawn(function* () { entered = true; }));
  assert.equal(entered, false);
  assert.equal(job.cancel(Number.NaN), true);
  assert.equal(job.cancel("replacement"), false);
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: Number.NaN });
  assert.equal(entered, false);
  await root.close();
});

test("created cancellation is terminal without entry and preserves undefined reason", async () => {
  const root = createExecutionRoot();
  const job = root.run(() => Job.create(function* () { assert.fail("not entered"); }));
  assert.equal(job.cancel(), true);
  assert.equal(job.state, "cancelled");
  assert.equal(job.start(), false);
  assert.equal(job.cancel("again"), false);
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: undefined });
  assert.throws(() => job.result, JobStateError);
  await root.close();
});

test("borrowed waits neither start nor acquire their target", async () => {
  const owner = createExecutionRoot();
  const borrower = createExecutionRoot();
  const target = owner.run(() => Job.create(function* () { return 7; }));
  const entered = gate();
  const waiter = borrower.run(() => Job.spawn(function* () {
    entered.release();
    try { yield* target.wait(); }
    catch (error) { assert.ok(error instanceof JobCancelledError); assert.equal(error.reason, "leave"); }
    return "caught";
  }));
  await entered.promise;
  await setImmediate();
  assert.equal(target.state, "created");
  waiter.cancel("leave");
  assert.deepEqual(await waitForJob(waiter), { state: "cancelled", reason: "leave" });
  await borrower.close();
  assert.equal(target.state, "created");
  target.start();
  assert.deepEqual(await waitForJob(target), { state: "finished", value: 7 });
  await owner.close();
});

test("target cancellation and an application-thrown cancellation error do not cancel the waiter", async () => {
  const root = createExecutionRoot();
  const reason = { why: "target" };
  const target = root.run(() => Job.create(function* () {}));
  target.cancel(reason);
  const waiter = root.run(() => Job.spawn(function* () {
    try { yield* target.wait(); }
    catch (error) { assert.ok(error instanceof JobCancelledError); assert.equal(error.reason, reason); return "recovered"; }
    return "unexpected";
  }));
  assert.deepEqual(await waitForJob(waiter), { state: "finished", value: "recovered" });
  const error = new JobCancelledError("application error");
  const thrown = root.run(() => Job.spawn(function* () { throw error; }));
  assert.equal(failure(await waitForJob(thrown)), error);
  await root.close();
});

test("a parent waits for active child I/O and finally before publishing its outcome", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const io = gate();
  const cleanup = gate();
  const cleaning = gate();
  let child!: Job<void>;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.spawn(function* () {
      try { yield* fromAsync(() => { entered.release(); return io.promise; }); }
      finally { yield* fromAsync(() => { cleaning.release(); return cleanup.promise; }); }
    });
    yield* fromAsync(() => entered.promise);
    return 9;
  }));
  await entered.promise;
  await setImmediate();
  assert.equal(child.state, "cancelling");
  assert.equal(parent.outcome, undefined);
  io.release();
  await cleaning.promise;
  assert.equal(parent.outcome, undefined);
  cleanup.release();
  assert.deepEqual(await waitForJob(parent), { state: "finished", value: 9 });
  assert.deepEqual(child.outcome, { state: "cancelled", reason: undefined });
  await root.close();
});

test("creation owns even unstarted children and a closing Job rejects new admission", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const hold = gate();
  let child!: Job<void>;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.create(function* () { assert.fail("unstarted child body"); });
    try { yield* fromAsync(() => { entered.release(); return hold.promise; }); }
    catch {
      assert.throws(() => Job.create(function* () {}), (error) => error instanceof JobStateError && error.state === "cancelling");
      assert.equal(child.start(), false);
    }
  }));
  await entered.promise;
  parent.cancel("parent");
  assert.deepEqual(child.outcome, { state: "cancelled", reason: "parent" });
  hold.release();
  assert.deepEqual(await waitForJob(parent), { state: "cancelled", reason: "parent" });
  await root.close();
});

test("unread child business failure does not fail its owner or root closing", async () => {
  const root = createExecutionRoot();
  const error = new Error("child business error");
  let child!: Job<never>;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.spawn(function* () { throw error; });
    yield* fromAsync(() => setImmediate());
    return 1;
  }));
  assert.deepEqual(await waitForJob(parent), { state: "finished", value: 1 });
  assert.equal(failure(child.outcome!), error);
  await root.close();
});

test("child failures propagate through explicit waits with the original identity", async () => {
  const root = createExecutionRoot();
  const error = new Error("waited failure");
  const parent = root.run(() => Job.spawn(function* () {
    return yield* Job.spawn(function* () { throw error; }).wait();
  }));
  assert.equal(failure(await waitForJob(parent)), error);
  await root.close();
});

test("body failure and child shutdown failures aggregate original exceptions", async () => {
  const root = createExecutionRoot();
  const started = gate();
  const bodyError = new Error("parent body");
  const cleanupError = new Error("child cleanup");
  const parent = root.run(() => Job.spawn(function* () {
    Job.spawn(function* () {
      try { yield* fromAsync((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        started.release();
      })); }
      finally { throw cleanupError; }
    });
    yield* fromAsync(() => started.promise);
    throw bodyError;
  }));
  const error = failure(await waitForJob(parent));
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [bodyError, cleanupError]);
  await root.close();
});

test("root closing shares one Promise, refuses entry and joins resource shutdown", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const io = gate();
  const reason = { why: "shutdown" };
  let signal!: AbortSignal;
  const active = root.run(() => Job.spawn(function* () {
    yield* fromAsync((value) => { signal = value; entered.release(); return io.promise; });
  }));
  const created = root.run(() => Job.create(function* () { assert.fail("unstarted"); }));
  await entered.promise;
  const closing = root.close(reason);
  assert.equal(root.state, "closing");
  assert.equal(root.close("ignored"), closing);
  assert.throws(() => root.run(() => {}), TypeError);
  assert.equal(created.start(), false);
  assert.deepEqual(created.outcome, { state: "cancelled", reason });
  assert.equal(active.outcome, undefined);
  assert.ok(signal.reason instanceof JobCancelledError);
  assert.equal(signal.reason.reason, reason);
  io.release();
  await closing;
  assert.equal(root.state, "closed");
  assert.equal(root.close(), closing);
  assert.throws(() => root.run(() => {}), TypeError);
});

test("root close aggregates shutdown errors and keeps closed state after rejection", async () => {
  const root = createExecutionRoot();
  const started = [gate(), gate()];
  const errors = [new Error("first cleanup"), new Error("second cleanup")];
  root.run(() => errors.forEach((error, i) => Job.spawn(function* () {
    try { yield* fromAsync((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started[i]!.release();
    })); }
    finally { throw error; }
  })));
  await Promise.all(started.map((entry) => entry.promise));
  const closing = root.close();
  await assert.rejects(closing, (error) => error instanceof AggregateError && errors.every((item) => error.errors.includes(item)) && error.errors.length === 2);
  assert.equal(root.state, "closed");
  assert.equal(root.close(), closing);
});

test("a Job cannot enter a root or synchronously initiate closing its own root", async () => {
  const root = createExecutionRoot();
  const other = createExecutionRoot();
  const job = root.run(() => Job.spawn(function* () {
    assert.throws(() => root.run(() => assert.fail("reentry")), TypeError);
    assert.throws(() => other.run(() => assert.fail("other root")), TypeError);
    assert.throws(() => root.close(), TypeError);
    return 1;
  }));
  assert.deepEqual(await waitForJob(job), { state: "finished", value: 1 });
  assert.equal(root.state, "open");
  await Promise.all([root.close(), other.close()]);
});

test("unknown suspensions unwind through native finally and thenable results fail", async () => {
  const root = createExecutionRoot();
  let cleaned = false;
  const invalid = root.run(() => Job.spawn(function* (): Coroutine<void> {
    try {
      // @ts-expect-error untyped suspension boundary
      yield {};
    } finally { yield* fromAsync(() => { cleaned = true; }); }
  }));
  assert.ok(failure(await waitForJob(invalid)) instanceof TypeError);
  assert.equal(cleaned, true);
  const promise = root.run(() => Job.spawn(function* () { return Promise.resolve(42); }));
  assert.ok(failure(await waitForJob(promise)) instanceof TypeError);
  const thenable = root.run(() => Job.spawn(function* () { return { then() { assert.fail("must not assimilate"); } }; }));
  assert.ok(failure(await waitForJob(thenable)) instanceof TypeError);
  // @ts-expect-error asynchronous generators are not Core coroutines
  const asynchronous = root.run(() => Job.spawn(async function* () { return 1; }));
  assert.ok(failure(await waitForJob(asynchronous)) instanceof TypeError);
  await root.close();
});

test("independent shutdown failures remain distinct even when both throw undefined", async () => {
  const root = createExecutionRoot();
  const started = [gate(), gate()];
  root.run(() => started.forEach((entry) => Job.spawn(function* () {
    try { yield* fromAsync((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entry.release();
    })); }
    finally { throw undefined; }
  })));
  await Promise.all(started.map((entry) => entry.promise));
  await assert.rejects(root.close(), (error) => error instanceof AggregateError && error.errors.length === 2 && error.errors.every((value: unknown) => value === undefined));
});

test("waiting for owned cleanup during cancellation does not duplicate its failure", async () => {
  const root = createExecutionRoot();
  const childStarted = gate();
  const parentStarted = gate();
  const cleanupError = new Error("one cleanup failure");
  const parent = root.run(() => Job.spawn(function* () {
    const child = Job.spawn(function* () {
      try { yield* fromAsync((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        childStarted.release();
      })); }
      finally { throw cleanupError; }
    });
    yield* fromAsync(() => childStarted.promise);
    try { yield* fromAsync((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      parentStarted.release();
    })); }
    finally { yield* child.wait(); }
  }));
  await parentStarted.promise;
  const closing = root.close();
  assert.equal(failure(await waitForJob(parent)), cleanupError);
  await assert.rejects(closing, (error) => error === cleanupError);
});

test("an internal aggregate keeps its identity when propagated through a wait", async () => {
  const root = createExecutionRoot();
  const started = gate();
  const bodyError = new Error("child body");
  const cleanupError = new Error("grandchild cleanup");
  let child!: Job<never>;
  const parent = root.run(() => Job.spawn(function* () {
    child = Job.spawn(function* () {
      Job.spawn(function* () {
        try { yield* fromAsync((signal) => new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          started.release();
        })); }
        finally { throw cleanupError; }
      });
      yield* fromAsync(() => started.promise);
      throw bodyError;
    });
    return yield* child.wait();
  }));
  const error = failure(await waitForJob(parent));
  assert.equal(error, failure(child.outcome!));
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [bodyError, cleanupError]);
  await root.close();
});

function typeContract() {
  const job = Job.create(function* () { return 1; });
  const result: number = job.result;
  const root = createExecutionRoot();
  // @ts-expect-error a root cannot propagate ownership to a Promise
  root.run(() => Promise.resolve(1));
  // @ts-expect-error a Job body must be a coroutine
  Job.create(async () => 1);
  // @ts-expect-error Core handles expose no Promise
  job.then;
  // @ts-expect-error no host Promise is part of the Core handle
  job.done;
  void result;
}
void typeContract;
