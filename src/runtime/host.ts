import { suspend, type Coroutine } from "./protocol.js";

/** Host operations begin only when a Job advances to this suspension. */
export function* fromAsync<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  options?: { readonly cleanup?: boolean },
): Coroutine<T> {
  // The Job resumes this registered operation with its own typed result.
  return (yield suspend({ kind: "async", operation, cleanup: options?.cleanup === true })) as T;
}
