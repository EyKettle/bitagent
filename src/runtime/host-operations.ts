import { waitForResume, type Operation } from "./kernel.js";
import type { AsyncSuspension, Resume } from "./protocol.js";

export interface ExecutionControl {
  readonly cancellation: Error | undefined;
  readonly notified: boolean;
  notifyCancellation(): Error;
  onCancel(interrupt: () => void): () => void;
  enter<T>(operation: () => T): T;
}

/** An abort requests interruption; the operation's settlement proves completion. */
export function performAsync(operation: AsyncSuspension, control: ExecutionControl): Operation<Resume> {
  return waitForResume((resume) => {
    const controller = new AbortController();
    const protectedWork = operation.cleanup || control.notified;
    const detach = protectedWork ? () => {} : control.onCancel(() => controller.abort(control.cancellation));
    let result: unknown;
    try {
      result = control.enter(() => operation.operation(controller.signal));
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(
      (value) => resume(control.cancellation !== undefined && !protectedWork
        ? { kind: "throw", error: control.notifyCancellation() }
        : { kind: "next", value }),
      (error: unknown) => {
        if (controller.signal.aborted && Object.is(error, control.cancellation)) control.notifyCancellation();
        resume({ kind: "throw", error });
      },
    );
    return detach;
  });
}
