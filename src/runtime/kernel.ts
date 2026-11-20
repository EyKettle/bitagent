import { action, createScope, type Operation } from "effection";
import type { Resume } from "./protocol.js";

/** All Effection types and handles stay behind this adapter. */
export function createKernel() {
  const [scope, destroy] = createScope();
  return {
    start(work: () => Operation<void>): void {
      queueMicrotask(() => { void scope.run(work); });
    },
    close(): Promise<void> { return destroy(); },
  };
}

export function waitFor<T>(promise: PromiseLike<T>): Operation<T> {
  return action<T>((resolve, reject) => {
    promise.then(resolve, reject);
    return () => {};
  });
}

export function waitForResume(subscribe: (resume: (value: Resume) => void) => () => void): Operation<Resume> {
  return action(subscribe);
}
export type { Operation } from "effection";
