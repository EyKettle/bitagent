/** Host-owned roots, I/O adaptation and terminal observation. */
export { fromAsync } from "./runtime/host.js";
export { createExecutionRoot, waitForJob } from "./runtime/jobs.js";
export type { ExecutionRoot, ExecutionRootState } from "./runtime/types.js";
