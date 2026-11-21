import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Job, JobCancelledError } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob } from "@bitagent/core/host";

import { gate, failure } from "./fixtures/control.mjs";

test("host invocation is deferred to suspension and resumes with its typed completion", async () => {
  const root = createExecutionRoot();
  let calls = 0;
  const operation = fromAsync(() => { calls++; return { value: 41 }; });
  assert.equal(calls, 0);
  const job = root.run(() => Job.create(function* () {
    const result = yield* operation;
    return result.value + 1;
  }));
  const observation = waitForJob(job);
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(job.state, "created");
  job.start();
  assert.equal(calls, 0);
  assert.deepEqual(await observation, { state: "finished", value: 42 });
  assert.equal(calls, 1);
  assert.throws(() => waitForJob({ ...job }), TypeError);
  await root.close();
});

test("abort joins actual I/O before native catch and protected asynchronous finally", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const io = gate();
  const handling = gate();
  const handled = gate();
  const cleaning = gate();
  const cleaned = gate();
  const events: string[] = [];
  const reason = { why: "cancel operation" };
  let signal!: AbortSignal;
  let notices = 0;
  const job = root.run(() => Job.spawn(function* () {
    try {
      yield* fromAsync((value) => { signal = value; events.push("io-start"); entered.release(); return io.promise; });
      assert.fail("cancelled I/O did not deliver cancellation");
    } catch (error) {
      assert.equal(error, signal.reason);
      assert.ok(error instanceof JobCancelledError);
      assert.equal(error.reason, reason);
      notices++;
      events.push("catch");
      yield* fromAsync((protectedSignal) => {
        assert.equal(protectedSignal.aborted, false);
        handling.release();
        return handled.promise;
      });
      events.push("handled");
    } finally {
      yield* fromAsync((protectedSignal) => {
        assert.equal(protectedSignal.aborted, false);
        events.push("finally");
        cleaning.release();
        return cleaned.promise;
      });
      events.push("cleaned");
    }
    return "cannot publish finished";
  }));
  await entered.promise;
  assert.equal(job.cancel(reason), true);
  assert.equal(signal.aborted, true);
  assert.equal(job.state, "cancelling");
  assert.equal(job.outcome, undefined);
  await setImmediate();
  assert.deepEqual(events, ["io-start"]);
  const control = root.run(() => Job.spawn(function* () { return job.state; }));
  assert.deepEqual(await waitForJob(control), { state: "finished", value: "cancelling" });
  io.release();
  await handling.promise;
  assert.equal(job.outcome, undefined);
  assert.equal(job.cancel("replacement"), false);
  handled.release();
  await cleaning.promise;
  assert.equal(job.outcome, undefined);
  cleaned.release();
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason });
  assert.equal(notices, 1);
  assert.deepEqual(events, ["io-start", "catch", "handled", "finally", "cleaned"]);
  await root.close();
});

test("an adapter reports abort with the exact notification and other rejections remain failures", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const aborted = root.run(() => Job.spawn(function* () {
    yield* fromAsync((signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered.release();
    }));
  }));
  await entered.promise;
  aborted.cancel();
  assert.deepEqual(await waitForJob(aborted), { state: "cancelled", reason: undefined });
  const running = gate();
  const ending = gate();
  const independent = new JobCancelledError("independent, same class");
  const failed = root.run(() => Job.spawn(function* () {
    yield* fromAsync(() => { running.release(); return ending.promise; });
  }));
  await running.promise;
  failed.cancel("request");
  ending.reject(independent);
  assert.equal(failure(await waitForJob(failed)), independent);
  await root.close();
});

test("real operation error is delivered first and pending cancellation precedes the next ordinary operation", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const io = gate();
  const error = new Error("independent transport failure");
  const events: string[] = [];
  let notice!: JobCancelledError;
  const job = root.run(() => Job.spawn(function* () {
    try { yield* fromAsync(() => { entered.release(); return io.promise; }); }
    catch (caught) { assert.equal(caught, error); events.push("error"); }
    const value = yield* fromAsync((signal) => {
      assert.equal(signal.aborted, false);
      events.push("cleanup");
      return 5;
    }, { cleanup: true });
    assert.equal(value, 5);
    try { yield* fromAsync(() => assert.fail("ordinary operation invoked before pending notice")); }
    catch (caught) { assert.ok(caught instanceof JobCancelledError); notice = caught; events.push("cancel"); }
    yield* fromAsync((signal) => { assert.equal(signal.aborted, false); events.push("protected"); });
    return 1;
  }));
  await entered.promise;
  io.reject(error);
  job.cancel("stop");
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: "stop" });
  assert.equal(notice.reason, "stop");
  assert.deepEqual(events, ["error", "cleanup", "cancel", "protected"]);
  await root.close();
});

test("cancellation during active declared cleanup preserves its signal, value and normal continuation", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const cleanup = gate<number>();
  const events: string[] = [];
  let signal!: AbortSignal;
  const job = root.run(() => Job.spawn(function* () {
    try { return "body"; }
    finally {
      const value = yield* fromAsync((value) => { signal = value; entered.release(); return cleanup.promise; }, { cleanup: true });
      assert.equal(value, 42);
      events.push("continued");
    }
  }));
  await entered.promise;
  job.cancel("during cleanup");
  assert.equal(signal.aborted, false);
  assert.equal(job.outcome, undefined);
  cleanup.release(42);
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: "during cleanup" });
  assert.deepEqual(events, ["continued"]);
  await root.close();
});

test("declared cleanup starts and completes while cancellation is pending but uninjected", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const ordinary = gate();
  const cleaning = gate();
  const cleanup = gate<string>();
  const opError = new Error("ordinary failure");
  let protectedSignal!: AbortSignal;
  const job = root.run(() => Job.spawn(function* () {
    try { yield* fromAsync(() => { entered.release(); return ordinary.promise; }); }
    catch (error) { assert.equal(error, opError); }
    const value = yield* fromAsync((signal) => { protectedSignal = signal; cleaning.release(); return cleanup.promise; }, { cleanup: true });
    assert.equal(value, "clean");
    return value;
  }));
  await entered.promise;
  job.cancel("stop");
  ordinary.reject(opError);
  await cleaning.promise;
  assert.equal(protectedSignal.aborted, false);
  assert.equal(job.outcome, undefined);
  cleanup.release("clean");
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: "stop" });
  await root.close();
});

test("cleanup errors remain original failures and root closing waits for and reports them", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const cleanup = gate();
  const error = new Error("cleanup failed");
  const job = root.run(() => Job.spawn(function* () {
    try { return 1; }
    finally { yield* fromAsync(() => { entered.release(); return cleanup.promise; }, { cleanup: true }); }
  }));
  await entered.promise;
  const closing = root.close("shutdown");
  assert.equal(root.state, "closing");
  assert.equal(job.outcome, undefined);
  cleanup.reject(error);
  assert.equal(failure(await waitForJob(job)), error);
  await assert.rejects(closing, (caught) => caught === error);
  assert.equal(root.state, "closed");
});

test("a handled cleanup error still cannot turn accepted cancellation into finished", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const cleanup = gate();
  const error = new Error("handled cleanup");
  const job = root.run(() => Job.spawn(function* () {
    try { yield* fromAsync(() => { entered.release(); return cleanup.promise; }, { cleanup: true }); }
    catch (caught) { assert.equal(caught, error); return "handled"; }
    return "not reached";
  }));
  await entered.promise;
  job.cancel();
  cleanup.reject(error);
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: undefined });
  await root.close();
});

test("accepted cancellation wins over successful I/O completion pending delivery", async () => {
  const root = createExecutionRoot();
  const entered = gate();
  const io = gate<number>();
  const job = root.run(() => Job.spawn(function* () { return yield* fromAsync(() => { entered.release(); return io.promise; }); }));
  await entered.promise;
  io.release(42);
  assert.equal(job.cancel("before commit"), true);
  assert.deepEqual(await waitForJob(job), { state: "cancelled", reason: "before commit" });
  const finished = root.run(() => Job.spawn(function* () { return yield* fromAsync(() => 7); }));
  assert.deepEqual(await waitForJob(finished), { state: "finished", value: 7 });
  assert.equal(finished.cancel("after commit"), false);
  await root.close();
});

test("cancellation remains admissible after body exit until owned cleanup settles", async () => {
  const root = createExecutionRoot();
  const childEntered = gate();
  const cleaning = gate();
  const cleanup = gate();
  const bodyExited = gate();
  const parent = root.run(() => Job.spawn(function* () {
    Job.spawn(function* () {
      try { yield* fromAsync((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        childEntered.release();
      })); }
      finally { yield* fromAsync(() => { cleaning.release(); return cleanup.promise; }); }
    });
    yield* fromAsync(() => childEntered.promise);
    bodyExited.release();
    return 3;
  }));
  await bodyExited.promise;
  await cleaning.promise;
  assert.equal(parent.state, "generating");
  assert.equal(parent.cancel("after body"), true);
  assert.equal(parent.outcome, undefined);
  cleanup.release();
  assert.deepEqual(await waitForJob(parent), { state: "cancelled", reason: "after body" });
  await root.close();
});

test("host callback ownership is synchronous and independent roots stay responsive during I/O", async () => {
  const a = createExecutionRoot();
  const b = createExecutionRoot();
  const entered = gate();
  const ending = gate();
  let asynchronous!: Promise<void>;
  let child!: Job<number>;
  const job = a.run(() => Job.spawn(function* () {
    yield* fromAsync(() => {
      child = Job.create(function* () { return 2; });
      asynchronous = Promise.resolve().then(() => { assert.throws(() => Job.create(function* () {}), TypeError); });
      entered.release();
      return ending.promise;
    });
    return 1;
  }));
  await entered.promise;
  await asynchronous;
  assert.equal(child.state, "created");
  const control = b.run(() => Job.spawn(function* () { return a.state; }));
  assert.deepEqual(await waitForJob(control), { state: "finished", value: "open" });
  const closing = a.close();
  assert.equal(job.outcome, undefined);
  assert.equal(child.state, "cancelled");
  ending.release();
  await closing;
  await b.close();
});
