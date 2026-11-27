import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Application } from "../dist/context/application/index.js";

const entry = fileURLToPath(new URL("../dist/interface/console/index.js", import.meta.url));

test("the live Console retains definitions and updates them without replay", () => {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", entry], {
    input: [
      'console.log("defined once"); const n = 1',
      "n + 1",
      "let counter: number = 3",
      "function read() { return counter; }",
      "counter += 4",
      "read()",
      'counter = "bad"',
      "read()",
      ".drop counter",
      "counter",
      "let counter: number = 100",
      "read() + counter + n",
      "",
    ].join("\n"),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "defined once\n2\n7\n7\n7\nDropped counter\n108\n", result.stderr);
  assert.match(result.stderr, /type TS2322 .*Type 'string' is not assignable to type 'number'/u);
  assert.match(result.stderr, /type TS2304 .*Cannot find name 'counter'/u);
  assert.doesNotMatch(result.stderr, /Execution error/u);
});

test("a retained binding keeps its exact type without requiring declaration emit", async () => {
  const application = new Application();
  assert.equal((await application.submit(`const item = new (class { private x = 42; read() { return this.x; } })();
    type Box<T> = { value: T };`)).kind, "success");
  const accepted = await application.submit("const boxed: Box<typeof item> = { value: item }; boxed.value.read()");
  assert.deepEqual(accepted, { kind: "success", hasValue: true, value: 42 });
  const incompatible = await application.submit("const wrong: Box<typeof item> = { value: { read: () => 42 } }");
  assert.equal(incompatible.kind, "diagnostic");
  assert(incompatible.diagnostics.some(({ code }) => code === 2741));
});

test("checked destructuring and bare calls preserve their TypeScript meaning across inputs", async () => {
  const application = new Application();
  assert.equal((await application.submit("let a = 1; let f = function (this: void) { return this; };")).kind, "success");
  assert.deepEqual(await application.submit("({ a = 7 } = {}); const snapshot = { a }; snapshot.a"),
    { kind: "success", hasValue: true, value: 7 });
  assert.deepEqual(await application.submit("f?.()"), { kind: "success", hasValue: true, value: undefined });
});
