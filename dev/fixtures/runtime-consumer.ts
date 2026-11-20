import { Job, JobCancelledError, JobStateError, type Coroutine, type JobOutcome, type JobState } from "@bitagent/core";
import { createExecutionRoot, fromAsync, waitForJob, type ExecutionRoot, type ExecutionRootState } from "@bitagent/core/host";

const root: ExecutionRoot = createExecutionRoot();
const rootState: ExecutionRootState = root.state;
const job: Job<number> = root.run(() => Job.create(function* (): Coroutine<number> {
  const value = yield* fromAsync(() => Promise.resolve(41), { cleanup: true });
  return value + 1;
}));
const state: JobState = job.state;
const outcome: Promise<JobOutcome<number>> = waitForJob(job);
const value: number = job.result;
// @ts-expect-error Core handles are not thenables
job.then;
// @ts-expect-error host ownership is synchronous
root.run(async () => 1);
// @ts-expect-error asynchronous iterators are not Core coroutines
Job.spawn(async function* () { return 1; });
// @ts-expect-error suspensions require a Core primitive
const invalid: Coroutine<void> = (function* () { yield {}; })();
void [rootState, state, outcome, value, invalid, JobCancelledError, JobStateError];
