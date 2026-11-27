import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ExecutionContext, Project, TypeScriptCompiler } from "../dist/runtime/compiler/index.js";
import { Definitions } from "../dist/runtime/operation/index.js";

const entry = fileURLToPath(new URL("../dist/interface/console/index.js", import.meta.url));
const setup = 'console.log("original ran"); let counter: number = 5; function original() { return counter; }';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "bitagent-binding-exports-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const workspace = join(directory, "workspace");
  const foreign = join(directory, "foreign");
  mkdirSync(workspace);
  mkdirSync(foreign);
  return { workspace, foreign };
}

function run(workspace, lines) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--experimental-import-meta-resolve", entry, "--workspace", workspace,
  ], { input: [...lines, ""].join("\n"), encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return {
    ...result,
    feedback: result.stderr.split("\n").filter((line) => /^(?:syntax |type |Execution error:)/u.test(line)),
  };
}

test("a Console export of a retained mutable binding does not create a bare alias", (t) => {
  const { workspace } = fixture(t);
  const result = run(workspace, [
    setup,
    'const label = "local"; export { counter as current, label }; counter += 1; counter;',
    "[counter, original(), label];",
    "current;",
    'console.log("rejected Console body"); export { counter as current }; counter = "wrong";',
    "counter + 36;",
  ]);
  assert.equal(result.stdout, "original ran\n6\n[ 6, 6, 'local' ]\n42\n", result.stderr);
  assert.equal(result.feedback.length, 2, result.stderr);
  assert.match(result.feedback[0], /^type TS2304 .*Cannot find name 'current'\.$/u);
  assert.match(result.feedback[1], /^type TS2322 .*Type 'string' is not assignable to type 'number'\.$/u);
});

test("an explicit script exports and updates the same binding without replaying its definition", (t) => {
  const { workspace, foreign } = fixture(t);
  const script = join(foreign, "batch.ts");
  const rejected = join(foreign, "rejected.ts");
  writeFileSync(script, [
    "export { counter as current, readBatch };",
    'console.log("batch saw", counter);',
    "counter += 1;",
    "function readBatch() { return counter; }",
    "counter;",
  ].join("\n"));
  writeFileSync(rejected, 'export { counter as current };\nconsole.log("rejected file body");\ncounter = "wrong";\n');
  const result = run(workspace, [
    setup,
    `.file ${script}`,
    "counter;",
    ".run",
    "[counter, original(), readBatch()];",
    "current;",
    `.file ${rejected}`,
    ".run",
    "counter = 9; [original(), readBatch()];",
  ]);
  assert.equal(result.stdout, [
    "original ran", `Acquired ${script}`, "5", "batch saw 5", "6", "[ 6, 6, 6 ]", `Acquired ${rejected}`, "[ 9, 9 ]", "",
  ].join("\n"), result.stderr);
  assert.equal(result.feedback.length, 2, result.stderr);
  assert.match(result.feedback[0], /^type TS2304 .*Cannot find name 'current'\.$/u);
  assert.match(result.feedback[1], /^type TS2322 .*rejected\.ts:3:1: Type 'string' is not assignable to type 'number'\.$/u);
});

test("retained exports forward live values from their original modules", async (t) => {
  const { workspace } = fixture(t);
  const context = new ExecutionContext({}, new Project(workspace));
  const compiler = new TypeScriptCompiler();
  const scope = new Definitions();
  async function submit(source) {
    const input = { source, fileName: context.project.consoleFile };
    const { result, definitions } = await compiler.executeBatch(input, context, scope);
    assert.equal(result.kind, "success", result.kind === "execution-error" ? String(result.error) : JSON.stringify(result));
    if (definitions) scope.introduce(definitions);
    return { result, definitions };
  }

  await submit("let counter: number = 5; type Marker = { value: number }; const fixed = 7;");
  await submit("let other = 10;");
  const exported = await submit([
    "const local: Marker = { value: 3 };",
    'export { counter, counter as current, counter as default, other as "another value", local, fixed, type Marker };',
    "counter += 1;",
    "counter;",
  ].join("\n"));
  assert.deepEqual(exported.result, { kind: "success", hasValue: true, value: 6 });
  const namespace = exported.definitions.find(({ name }) => name === "local").module.namespace;
  assert.equal(namespace.counter, 6);
  assert.equal(namespace.current, 6);
  assert.equal(namespace.default, 6);
  assert.equal(namespace["another value"], 10);
  assert.equal(namespace.local.value, 3);
  assert.equal(namespace.fixed, 7);
  assert.equal(Object.hasOwn(namespace, "Marker"), false);
  assert.equal(scope.bindings.has("current"), false);

  await submit("counter = 9; other = 11;");
  assert.equal(namespace.counter, 9);
  assert.equal(namespace.current, 9);
  assert.equal(namespace.default, 9);
  assert.equal(namespace["another value"], 11);

  assert.equal(scope.drop("counter"), true);
  await submit("let counter = 70;");
  assert.equal(namespace.current, 9);
});
