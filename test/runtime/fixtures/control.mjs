import assert from "node:assert/strict";

/** @template [T=void] */
export function gate() {
  let release = /** @type {(value: T) => void} */ (() => {});
  let reject = /** @type {(error: unknown) => void} */ (() => {});
  const promise = new Promise(/** @param {(value: T) => void} done */ (done, fail) => {
    release = done;
    reject = fail;
  });
  return { promise, release, reject };
}

/** @param {import("@bitagent/core").JobOutcome<unknown>} outcome */
export function failure(outcome) {
  assert.equal(outcome.state, "failed");
  if (outcome.state !== "failed") throw new Error("Expected failure");
  return outcome.error;
}
