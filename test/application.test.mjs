import assert from "node:assert/strict";
import test from "node:test";

import { Application } from "../dist/context/application/index.js";

test("one application retains its context across a rejected input", async () => {
  const application = new Application();
  const accepted = application.submit('Reflect.set(globalThis, "stageOneMarker", 41)');
  const rejected = application.submit('Reflect.set(globalThis, "stageOneMarker", 0); const n: number = "bad";');
  const continued = application.submit('Number(Reflect.get(globalThis, "stageOneMarker")) + 1');

  assert.deepEqual(await accepted, { kind: "success", hasValue: true, value: true });
  assert.equal((await rejected).kind, "diagnostic");
  assert.deepEqual(await continued, { kind: "success", hasValue: true, value: 42 });
});

test("separate applications do not share their global objects", async () => {
  const first = new Application();
  const second = new Application();
  assert.equal((await first.submit('Reflect.set(globalThis, "applicationMarker", true)')).kind, "success");
  assert.deepEqual(await second.submit('Reflect.has(globalThis, "applicationMarker")'),
    { kind: "success", hasValue: true, value: false });
});
