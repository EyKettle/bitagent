// The mock leaves [wait] requests open until a later control file cancels them.
let waitingCompleted = false;
const waitingJob = app.start(function* () {
  const result = yield* translate("[wait]", "English");
  waitingCompleted = true;
  return result;
});
waitingJob.state;
