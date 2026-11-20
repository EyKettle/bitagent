import { createKernel, waitFor, waitForResume, type Operation } from "./kernel.js";
import { Lifetime } from "./lifetime.js";
import { CoroutineFailure, mergeFailures, observeFailure, propagateFailure, type Failure, type FailureSource } from "./failures.js";
import { performAsync, type ExecutionControl } from "./host-operations.js";
import { isObject, isThenable, readSuspension, suspend, type Coroutine, type Resume, type WaitSuspension } from "./protocol.js";
import { brandRoot, JobCancelledError, JobStateError } from "./types.js";
import type { ExecutionRoot, ExecutionRootState, Job as JobHandle, JobBody, JobOutcome, JobState } from "./types.js";

export { JobCancelledError, JobStateError } from "./types.js";
export type { JobOutcome, JobState } from "./types.js";
export type Job<T> = JobHandle<T>;

interface ExecutionContext {
  readonly root: Root;
  readonly lifetime: Lifetime;
  readonly job: { readonly state: JobState } | undefined;
}
let current: ExecutionContext | undefined;
let nextJobId = 1;
const completions = new WeakMap<JobHandle<unknown>, Promise<JobOutcome<unknown>>>();

function enter<T>(context: ExecutionContext, entry: () => T): T {
  const previous = current;
  current = context;
  try { return entry(); }
  finally { current = previous; }
}

function creationContext(): ExecutionContext {
  if (current === undefined) throw new TypeError("Job creation requires a current execution scope");
  if (!current.lifetime.accepting) {
    if (current.job !== undefined) throw new JobStateError(current.job.state, "Job scope no longer accepts work");
    throw new TypeError("Execution root no longer accepts work");
  }
  return current;
}

function rejectThenable(value: unknown, message: string): void {
  if (!isThenable(value)) return;
  // Reject the protocol without leaving a native rejected Promise unobserved.
  if (value instanceof Promise) void value.catch(() => {});
  throw new TypeError(message);
}

class Root {
  readonly lifetime = new Lifetime();
  readonly kernel = createKernel();
  private state: ExecutionRootState = "open";
  private closing: Promise<void> | undefined;
  readonly context: ExecutionContext = { root: this, lifetime: this.lifetime, job: undefined };
  readonly handle: ExecutionRoot;

  constructor() {
    const root = this;
    this.handle = brandRoot({
      get state() { return root.state; },
      run<T>(entry: (() => T) & ([Extract<T, PromiseLike<unknown>>] extends [never] ? unknown : never)): T {
        if (root.state !== "open") throw new TypeError("Execution root is closing or closed");
        if (current !== undefined && (current.job !== undefined || current.root !== root)) {
          throw new TypeError("Cannot enter a root from a Job or another root");
        }
        const value = enter(root.context, entry);
        rejectThenable(value, "Execution root entry must not return a thenable");
        return value;
      },
      close(reason?: unknown): Promise<void> { return root.close(reason); },
    });
  }

  private close(reason: unknown): Promise<void> {
    if (current?.root === this && current.job !== undefined) {
      throw new TypeError("A Job cannot close its own execution root");
    }
    if (this.closing !== undefined) return this.closing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.state = "closing";
    this.lifetime.stop(reason);
    void this.finishClose().then(resolve, reject);
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    const failures = [...await this.lifetime.drain()];
    try { await this.kernel.close(); }
    catch (error) { failures.push(...observeFailure(error).sources); }
    this.state = "closed";
    const failure = mergeFailures(undefined, failures);
    if (failure !== undefined) throw failure.error;
  }
}

class JobExecution<T> implements ExecutionControl {
  readonly lifetime = new Lifetime();
  readonly context: ExecutionContext;
  readonly settled: Promise<JobOutcome<T>>;
  readonly handle: JobHandle<T>;
  state: JobState = "created";
  private outcome: JobOutcome<T> | undefined;
  private failure: Failure | undefined;
  cancellation: JobCancelledError | undefined;
  notified = false;
  private interrupt: (() => void) | undefined;
  private resolve!: (outcome: JobOutcome<T>) => void;
  private readonly observers = new Set<(outcome: JobOutcome<T>) => void>();
  private body: (() => Coroutine<T>) | undefined;

  constructor(private readonly owner: ExecutionContext, body: () => Coroutine<T>) {
    this.body = body;
    this.context = { root: owner.root, lifetime: this.lifetime, job: this };
    this.settled = new Promise((resolve) => { this.resolve = resolve; });
    const execution = this;
    this.handle = Object.freeze({
      id: `job-${nextJobId++}`,
      get state() { return execution.state; },
      get outcome() { return execution.outcome; },
      get result(): T {
        if (execution.outcome?.state === "finished") return execution.outcome.value;
        throw new JobStateError(execution.state, "Only a finished Job has a result");
      },
      start: () => execution.start(),
      cancel: (reason?: unknown) => execution.cancel(reason),
      *wait(): Coroutine<T> {
        const outcome = (yield suspend({
          kind: "wait",
          subscribe: (resume) => execution.subscribe((value) => resume(execution.failure === undefined
            ? { kind: "next", value } : { kind: "next", value, failure: execution.failure })),
        })) as JobOutcome<T>;
        if (outcome.state === "finished") return outcome.value;
        throw outcome.state === "failed" ? outcome.error : new JobCancelledError(outcome.reason);
      },
    });
    completions.set(this.handle, this.settled);
    owner.lifetime.adopt(this);
  }

  start(): boolean {
    if (this.state !== "created" || !this.owner.lifetime.accepting) return false;
    this.state = "generating";
    this.owner.root.kernel.start(() => this.execute());
    return true;
  }

  cancel(reason: unknown = undefined): boolean {
    if (this.outcome !== undefined || this.cancellation !== undefined) return false;
    this.cancellation = new JobCancelledError(reason);
    const unstarted = this.state === "created";
    this.state = "cancelling";
    this.lifetime.stop(reason);
    if (unstarted) this.commit(Object.freeze({ state: "cancelled", reason }), [], undefined);
    else this.interrupt?.();
    return true;
  }

  enter<R>(operation: () => R): R { return enter(this.context, operation); }

  notifyCancellation(): JobCancelledError {
    if (this.cancellation === undefined) throw new Error("Cancellation has not been requested");
    this.notified = true;
    return this.cancellation;
  }

  onCancel(interrupt: () => void): () => void {
    this.interrupt = interrupt;
    return () => { if (this.interrupt === interrupt) this.interrupt = undefined; };
  }

  private subscribe(resume: (outcome: JobOutcome<T>) => void): () => void {
    if (this.outcome !== undefined) resume(this.outcome);
    else this.observers.add(resume);
    return () => { this.observers.delete(resume); };
  }

  private *execute(): Operation<void> {
    let value: T | undefined;
    let bodyFailure: Failure | undefined;
    let shutdownFailures: readonly FailureSource[] = [];
    try {
      if (this.cancellation === undefined) value = yield* this.drive();
    } catch (error) {
      const failure = error instanceof CoroutineFailure ? error.failure : observeFailure(error);
      if (this.cancellation === undefined || !Object.is(failure.error, this.cancellation)) {
        bodyFailure = failure;
        if (this.cancellation !== undefined) shutdownFailures = failure.sources;
      }
    }
    this.body = undefined;
    this.lifetime.stop(this.cancellation?.reason);
    const childFailures = yield* waitFor(this.lifetime.drain());
    const failure = mergeFailures(bodyFailure, childFailures);
    shutdownFailures = [...new Set([...shutdownFailures, ...childFailures])];
    const outcome: JobOutcome<T> = failure !== undefined
      ? { state: "failed", error: failure.error }
      : this.cancellation !== undefined
        ? { state: "cancelled", reason: this.cancellation.reason }
        // A noncancelled body always assigned its declared completion value.
        : { state: "finished", value: value as T };
    this.commit(Object.freeze(outcome), shutdownFailures, failure);
  }

  private *drive(): Operation<T> {
    const body = this.body;
    this.body = undefined;
    if (body === undefined) throw new TypeError("Job has no coroutine body");
    const iterator = this.enter(body);
    rejectThenable(iterator, "A Job body must return a coroutine, not a thenable");
    if (!isObject(iterator) || Symbol.asyncIterator in iterator ||
        typeof iterator.next !== "function" || typeof iterator.throw !== "function" ||
        typeof iterator.return !== "function" || typeof iterator[Symbol.iterator] !== "function") {
      throw new TypeError("A Job body must return a synchronous coroutine");
    }
    let resume: Resume = { kind: "next", value: undefined };
    // Only delivered failures seed provenance, owned for this driver lifetime.
    const delivered: Failure[] = [];
    while (true) {
      const next = resume;
      if (next.failure !== undefined) delivered.push(next.failure);
      else if (next.kind === "throw") delivered.push(observeFailure(next.error));
      let step: IteratorResult<unknown, T>;
      try {
        step = this.enter(() => next.kind === "throw" ? iterator.throw(next.error) : iterator.next(next.value));
      } catch (error) {
        throw new CoroutineFailure(propagateFailure(error, delivered));
      }
      rejectThenable(step, "A coroutine must produce synchronous iterator results");
      if (!isObject(step)) throw new TypeError("A coroutine must produce iterator results");
      if (step.done) {
        rejectThenable(step.value, "A coroutine must return a value, not a thenable");
        return step.value;
      }
      const operation = readSuspension(step.value);
      if (operation === undefined) {
        resume = { kind: "throw", error: new TypeError("Coroutine yielded an unknown suspension; use Core primitives with yield*") };
      } else if (this.cancellation !== undefined && !this.notified && !(operation.kind === "async" && operation.cleanup)) {
        resume = { kind: "throw", error: this.notifyCancellation() };
      } else {
        resume = operation.kind === "async" ? yield* performAsync(operation, this) : yield* this.wait(operation);
      }
    }
  }

  private wait(operation: WaitSuspension): Operation<Resume> {
    return waitForResume((resume) => {
      const detach = this.notified ? () => {} : this.onCancel(() => resume({ kind: "throw", error: this.notifyCancellation() }));
      const unsubscribe = operation.subscribe(resume);
      return () => { detach(); unsubscribe(); };
    });
  }

  private commit(outcome: JobOutcome<T>, shutdownFailures: readonly FailureSource[], failure: Failure | undefined): void {
    this.body = undefined;
    this.state = outcome.state;
    this.outcome = outcome;
    this.failure = failure;
    this.owner.lifetime.release(this, shutdownFailures);
    this.resolve(outcome);
    for (const resume of [...this.observers]) resume(outcome);
    this.observers.clear();
  }
}

export const Job = Object.freeze({
  create<T>(body: JobBody<T>): Job<T> {
    return new JobExecution(creationContext(), body).handle;
  },
  spawn<T>(body: JobBody<T>): Job<T> {
    const job = new JobExecution(creationContext(), body);
    job.start();
    return job.handle;
  },
});

export function createExecutionRoot(): ExecutionRoot { return new Root().handle; }

/** Observation acquires no execution ownership and performs no implicit start. */
export function waitForJob<T>(job: Job<T>): Promise<JobOutcome<T>> {
  const completion = completions.get(job);
  if (completion === undefined) throw new TypeError("Job does not belong to this Core runtime");
  return completion as Promise<JobOutcome<T>>;
}
