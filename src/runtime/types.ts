import type { Coroutine } from "./protocol.js";

type ThenFunctionSignature = ((...args: never[]) => unknown) | (abstract new (...args: never[]) => unknown);
type ThenableCompletion<T> = T extends { readonly then?: infer Then }
  ? unknown extends Then ? never : [Extract<Then, ThenFunctionSignature>] extends [never] ? never : T
  : never;

/** Reject known callable-then branches without widening completion inference. */
export type JobBody<T> = (() => Coroutine<T>) & NoInfer<
  unknown extends T ? unknown
    : [ThenableCompletion<T>] extends [never] ? unknown : never
>;

export type JobState =
  | "created" | "generating" | "cancelling"
  | "finished" | "failed" | "cancelled";
export type JobOutcome<T> =
  | { readonly state: "finished"; readonly value: T }
  | { readonly state: "failed"; readonly error: unknown }
  | { readonly state: "cancelled"; readonly reason: unknown };
export interface Job<T> {
  readonly id: string;
  readonly state: JobState;
  readonly outcome: JobOutcome<T> | undefined;
  readonly result: T;
  start(): boolean;
  wait(): Coroutine<T>;
  cancel(reason?: unknown): boolean;
}
export class JobStateError extends Error {
  constructor(readonly state: JobState, message: string) {
    super(message);
    this.name = "JobStateError";
  }
}
export class JobCancelledError extends Error {
  constructor(readonly reason: unknown = undefined) {
    super("Job cancelled");
    this.name = "JobCancelledError";
  }
}

const executionRootBrand: unique symbol = Symbol("Core execution root");
export type ExecutionRootState = "open" | "closing" | "closed";
export interface ExecutionRoot {
  readonly [executionRootBrand]: true;
  readonly state: ExecutionRootState;
  run<T>(entry: (() => T) & (
    [Extract<T, PromiseLike<unknown>>] extends [never] ? unknown : never
  )): T;
  close(reason?: unknown): Promise<void>;
}

const roots = new WeakSet<ExecutionRoot>();
export function isExecutionRoot(value: unknown): value is ExecutionRoot { return value !== null && typeof value === "object" && roots.has(value as ExecutionRoot); }
export function brandRoot(root: Omit<ExecutionRoot, typeof executionRootBrand>): ExecutionRoot {
  Object.defineProperty(root, executionRootBrand, { value: true });
  const handle = Object.freeze(root) as ExecutionRoot; roots.add(handle); return handle;
}
