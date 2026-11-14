/** A suspension can only be produced by a coroutine primitive. */
export interface Suspension { readonly kind: unique symbol; }

/** Use yield* to suspend and receive a statically typed completion value. */
export type Coroutine<T> = Generator<Suspension, T, unknown>;

export type TaskOutcome<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason: unknown };

export type TaskState<T> =
  | { readonly status: "queued" | "running" | "waiting" | "cancelling" }
  | TaskOutcome<T>;

export interface Task<T> {
  readonly id: number;
  readonly state: TaskState<T>;
  /** Waits in this coroutine; it does not block the instance or cancel the target. */
  join(): Coroutine<T>;
  /** Requests cooperative cancellation, not immediate settlement. */
  cancel(reason?: unknown): boolean;
}

export interface Scheduler {
  start<T>(work: () => Coroutine<T>): Task<T>;
  list(): readonly Task<unknown>[];
  /** Removes a settled task registration; existing references still work. */
  forget(task: Task<unknown>): boolean;
}

export class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled");
    this.name = "TaskCancelledError";
  }
}

type Operation = (signal: AbortSignal) => unknown | PromiseLike<unknown>;
const operations = new WeakMap<Suspension, Operation>();
const completions = new WeakMap<Task<unknown>, Promise<TaskOutcome<unknown>>>();

/** Host adapter primitive. Public user scripts consume its coroutine, not its Promise. */
export function* fromAsync<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Coroutine<T> {
  const suspension = Object.freeze({}) as Suspension;
  operations.set(suspension, operation);
  // The scheduler resumes this suspension only with this operation's result.
  return (yield suspension) as T;
}

/** Host integration only: tasks intentionally expose no Promise on their public handles. */
export function waitForTask<T>(task: Task<T>): Promise<TaskOutcome<T>> {
  const completion = completions.get(task);
  if (completion === undefined) throw new TypeError("Task does not belong to this runtime");
  // Task identity preserves T across the heterogeneous completion table.
  return completion as Promise<TaskOutcome<T>>;
}

function waitWithSignal<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isSettled<T>(state: TaskState<T>): state is TaskOutcome<T> {
  return state.status === "succeeded" || state.status === "failed" || state.status === "cancelled";
}

function failure<T>(error: unknown, signal: AbortSignal): TaskOutcome<T> {
  return signal.aborted && Object.is(error, signal.reason)
    ? Object.freeze({ status: "cancelled", reason: signal.reason })
    : Object.freeze({ status: "failed", error });
}

export function createScheduler(): Scheduler {
  const tasks = new Map<number, Task<unknown>>();
  let nextId = 1;

  return Object.freeze({
    start<T>(work: () => Coroutine<T>): Task<T> {
      const controller = new AbortController();
      let state: TaskState<T> = Object.freeze({ status: "queued" });
      let settle!: (outcome: TaskOutcome<T>) => void;
      const completion = new Promise<TaskOutcome<T>>((resolve) => { settle = resolve; });
      const task: Task<T> = Object.freeze({
        id: nextId++,
        get state() { return state; },
        *join(): Coroutine<T> {
          const outcome = yield* fromAsync((signal) => waitWithSignal(completion, signal));
          if (outcome.status === "succeeded") return outcome.value;
          throw outcome.status === "failed" ? outcome.error : outcome.reason;
        },
        cancel(reason: unknown = new TaskCancelledError()): boolean {
          if (isSettled(state) || state.status === "cancelling") return false;
          state = Object.freeze({ status: "cancelling" });
          controller.abort(reason);
          return true;
        },
      });
      tasks.set(task.id, task);
      completions.set(task, completion);

      function setActive(status: "running" | "waiting") {
        if (!controller.signal.aborted) state = Object.freeze({ status });
      }

      async function drive(): Promise<void> {
        let outcome: TaskOutcome<T>;
        try {
          controller.signal.throwIfAborted();
          setActive("running");
          const coroutine = work();
          if (coroutine === null || typeof coroutine?.next !== "function" || Symbol.asyncIterator in coroutine) {
            throw new TypeError("Scheduled work must return a coroutine, not an async function or value");
          }
          let step = coroutine.next();
          while (!step.done) {
            setActive("waiting");
            let value: unknown;
            try {
              controller.signal.throwIfAborted();
              const operation = operations.get(step.value);
              if (operation === undefined) throw new TypeError("Coroutine yielded an unknown suspension; use yield*");
              value = await operation(controller.signal);
              controller.signal.throwIfAborted();
            } catch (error) {
              setActive("running");
              step = coroutine.throw(error);
              continue;
            }
            setActive("running");
            step = coroutine.next(value);
          }
          // Do not assimilate an accidentally returned Promise into a successful task.
          if (step.value !== null && (typeof step.value === "object" || typeof step.value === "function") &&
              "then" in step.value && typeof step.value.then === "function") {
            throw new TypeError("A coroutine must return its completion value, not a Promise");
          }
          outcome = Object.freeze({ status: "succeeded", value: step.value });
        } catch (error) {
          outcome = failure(error, controller.signal);
        }
        // Observers and joining coroutines can only run after the complete state is committed.
        state = outcome;
        settle(outcome);
      }

      queueMicrotask(() => { void drive(); });
      return task;
    },
    list: () => Object.freeze([...tasks.values()]),
    forget(task: Task<unknown>): boolean {
      if (tasks.get(task.id) !== task) return false;
      if (!isSettled(task.state)) throw new Error("Cannot forget a task before it settles");
      return tasks.delete(task.id);
    },
  });
}
