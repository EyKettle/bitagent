export interface RunContext {
  readonly signal: AbortSignal;
}

export type Work<T> = (context: RunContext) => T | PromiseLike<T>;

export type RunOutcome<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "cancelled"; readonly reason: unknown };

export type RunState<T> =
  | { readonly status: "running" | "cancelling" }
  | RunOutcome<T>;

export interface Run<T> {
  /** Identity within the owning application, not a persistent or global ID. */
  readonly id: number;
  readonly state: RunState<T>;
  /** Always resolves, including failure, so unattended work cannot reject unobserved. */
  readonly done: Promise<RunOutcome<T>>;
  /** Requests cancellation. The function must observe its signal to stop. */
  cancel(reason?: unknown): boolean;
}

export interface Application {
  start<T>(work: Work<T>): Run<T>;
  list(): readonly Run<unknown>[];
  /** Removes only settled runs owned by this application. Existing handles still work. */
  forget(run: Run<unknown>): boolean;
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export function createApplication(): Application {
  const runs = new Map<number, Run<unknown>>();
  let nextId = 1;

  return Object.freeze({
    start<T>(work: Work<T>): Run<T> {
      const controller = new AbortController();
      let state: RunState<T> = Object.freeze({ status: "running" });
      const done = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return work(Object.freeze({ signal: controller.signal }));
        })
        .then<RunOutcome<T>, RunOutcome<T>>(
          (value) => {
            const outcome = Object.freeze({ status: "succeeded" as const, value });
            state = outcome;
            return outcome;
          },
          (error: unknown) => {
            // An unrelated exception is still a failure, even after a cancel request.
            const outcome: RunOutcome<T> = controller.signal.aborted && Object.is(error, controller.signal.reason)
              ? Object.freeze({ status: "cancelled", reason: controller.signal.reason })
              : Object.freeze({ status: "failed", error });
            state = outcome;
            return outcome;
          },
        );
      const run: Run<T> = Object.freeze({
        id: nextId++,
        get state() { return state; },
        done,
        cancel(reason: unknown = new RunCancelledError()): boolean {
          if (state.status !== "running") return false;
          state = Object.freeze({ status: "cancelling" });
          controller.abort(reason);
          return true;
        },
      });
      runs.set(run.id, run);
      return run;
    },
    list: () => Object.freeze([...runs.values()]),
    forget(run: Run<unknown>): boolean {
      if (runs.get(run.id) !== run) return false;
      if (run.state.status === "running" || run.state.status === "cancelling") {
        throw new Error("Cannot forget a run before it settles");
      }
      return runs.delete(run.id);
    },
  });
}
