import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileConsumer } from "./compiler.mjs";

test("built public declarations preserve Core and Host types without exposing the kernel or Node types", () => {
  const fixture = fileURLToPath(new URL("./fixtures/runtime-consumer.ts", import.meta.url));
  const program = compileConsumer(fixture);
  const exposed = program.getSourceFiles().filter((source) => /[/\\]node_modules[/\\](?:effection|@types[/\\]node)[/\\]/.test(source.fileName));
  assert.deepEqual(exposed.map((source) => source.fileName), []);
});
