import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionContext, TypeScriptCompiler } from "../dist/runtime/compiler/index.js";

function executor() {
  const effects = [];
  const context = new ExecutionContext({ console: { log: (message) => effects.push(message) } });
  const compiler = new TypeScriptCompiler();
  return { effects, execute: (source) => compiler.execute({ fileName: "compiler-input.ts", source }, context) };
}

test("checks and executes TypeScript and returns a plain expression value", async () => {
  const { execute, effects } = executor();
  const result = await execute('const n: number = 40; console.log("ran"); n + 2');
  assert.deepEqual(result, { kind: "success", hasValue: true, value: 42 });
  assert.deepEqual(effects, ["ran"]);
});

test("a syntax error prevents observable effects", async () => {
  const { execute, effects } = executor();
  const result = await execute('console.log("not run"); const = 5;');
  assert.equal(result.kind, "diagnostic");
  assert(result.diagnostics.some(({ kind, line }) => kind === "syntax" && line === 1));
  assert.deepEqual(effects, []);
});

test("a type error prevents observable effects", async () => {
  const { execute, effects } = executor();
  const result = await execute('console.log("not run"); const n: number = "wrong";');
  assert.equal(result.kind, "diagnostic");
  assert(result.diagnostics.some(({ kind, code }) => kind === "type" && code === 2322));
  assert.deepEqual(effects, []);
});

test("a checked throw is distinct from a compiler diagnostic", async () => {
  const { execute, effects } = executor();
  const result = await execute('console.log("ran"); throw new Error("checked throw");');
  assert.equal(result.kind, "execution-error");
  assert.equal(result.error.message, "checked throw");
  assert.deepEqual(effects, ["ran"]);
});
