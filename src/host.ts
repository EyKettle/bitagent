/** Host I/O bridges; application scripts use the coroutine-facing root API. */
export { fromAsync } from "./runtime/host.js";
export { createExecutionRoot, waitForJob } from "./runtime/jobs.js";
export type { ExecutionRoot, ExecutionRootState } from "./runtime/types.js";
export { waitForTask } from "./coroutine.js";
