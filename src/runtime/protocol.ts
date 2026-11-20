import type { Failure } from "./failures.js";

/** Only registered Core primitives produce executable suspension values. */
const suspensionBrand: unique symbol = Symbol("Core suspension");
export interface Suspension { readonly [suspensionBrand]: true; }
export type Coroutine<T> = Generator<Suspension, T, unknown>;

export type Resume =
  | { readonly kind: "next"; readonly value: unknown; readonly failure?: Failure }
  | { readonly kind: "throw"; readonly error: unknown; readonly failure?: Failure };
export interface AsyncSuspension {
  readonly kind: "async";
  readonly operation: (signal: AbortSignal) => unknown | PromiseLike<unknown>;
  readonly cleanup: boolean;
}
export interface WaitSuspension {
  readonly kind: "wait";
  readonly subscribe: (resume: (value: Resume) => void) => () => void;
}
export type SuspensionOperation = AsyncSuspension | WaitSuspension;
const operations = new WeakMap<Suspension, SuspensionOperation>();

export function suspend(operation: SuspensionOperation): Suspension {
  const value: Suspension = Object.freeze({ [suspensionBrand]: true as const });
  operations.set(value, operation);
  return value;
}

export function readSuspension(value: unknown): SuspensionOperation | undefined {
  return isObject(value) ? operations.get(value as Suspension) : undefined;
}

export function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

export function isThenable(value: unknown): boolean {
  return isObject(value) && "then" in value && typeof value.then === "function";
}
