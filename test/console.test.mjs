import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/interface/console/index.js", import.meta.url));

test("the Console previews expressions, distinguishes failures, and keeps accepting input", () => {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", entry], {
    input: [
      "1 + 1",
      'console.log("rejected effect"); const n: number = "bad";',
      'throw new Error("checked throw");',
      'console.log("ordinary effect"); 6 * 7',
      "",
    ].join("\n"),
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "2\nordinary effect\n42\n");
  assert.match(result.stderr, /type TS2322 .*Type 'string' is not assignable to type 'number'/);
  assert.match(result.stderr, /Execution error: Error: checked throw/);
});
