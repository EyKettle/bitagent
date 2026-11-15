import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createScheduler } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { createPiEntity } from "@bitagent/core/pi";
import { createFileSession, FileCompileError } from "@bitagent/core/node";

function fixture(t) {
  mkdirSync(".build", { recursive: true });
  const cwd = mkdtempSync(resolve(".build", "files-"));
  mkdirSync(join(cwd, "node_modules", "@bitagent"), { recursive: true });
  symlinkSync(resolve("."), join(cwd, "node_modules", "@bitagent", "core"), "dir");
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const app = createScheduler();
  const llm = createPiEntity(models, faux.getModel());
  const files = createFileSession({ app, llm, cwd });
  t.after(() => files.close());
  const file = (name, source) => { const path = join(cwd, name); writeFileSync(path, source); return path; };
  return { cwd, faux, app, llm, files, file };
}

function editorProgram(fixture, source) {
  const path = fixture.file("editor.ts", source);
  const options = { strict: true, skipLibCheck: false, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Force, types: [] };
  const program = ts.createProgram([path, fixture.files.declarationsPath], options);
  return { program, path, diagnostics: ts.getPreEmitDiagnostics(program) };
}
const diagnosticText = (items) => items.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n");

test("files retain actual variable bindings, functions, types and explicit cleanup", (t) => {
  const f = fixture(t);
  const first = f.file("first.ts", `
    interface Box<T extends { name: string } = { name: string }> { value: T }
    let 次数 = 1;
    let value = 2;
    function next() { return ++次数; }
    function accept(box: Box) { return box.value.name; }
    const fixed = "constant";
    const enum Mode { A, B }
  `);
  f.files.runFile(first);
  assert.equal(f.files.evaluate("次数 = 10; next()").value, 11);
  assert.equal(f.files.evaluate("次数").value, 11);
  assert.equal(f.files.evaluate("value = 5; value").value, 5);
  assert.equal(f.files.evaluate("value").value, 5);
  assert.throws(() => f.files.evaluate('fixed = "changed"'), FileCompileError);
  assert.throws(() => f.files.evaluate("let 次数 = 99"), /already exists/);
  let editor = editorProgram(f, `const box: Box = {value:{name:"ok"}}; accept(box); const mode: Mode.A = Mode.A;\nnext().toUpperCase();`);
  assert.match(diagnosticText(editor.diagnostics), /toUpperCase/);
  assert.equal(editor.diagnostics.length, 1, diagnosticText(editor.diagnostics));
  const oldType = f.files.scope.list().find((item) => item.name === "Box");
  assert.equal(f.files.scope.forget(oldType), true);
  f.files.evaluate('type Box = number;');
  editor = editorProgram(f, 'const box: Box = 2; accept({value:{name:"still original"}});');
  assert.equal(editor.diagnostics.length, 0, diagnosticText(editor.diagnostics));
  const counter = f.files.scope.list().find((item) => item.name === "次数");
  assert.equal(f.files.scope.forget(counter), true);
  assert.equal(f.files.scope.forget(counter), false);
  f.files.evaluate('let 次数 = "new";');
  assert.equal(f.files.evaluate('next()').value, 12);
  assert.equal(f.files.evaluate('次数').value, "new");
});

test("a type error runs nothing; a runtime error retains initialized definitions", (t) => {
  const { files } = fixture(t);
  files.evaluate("let count = 0;");
  assert.throws(() => files.evaluate('count++; const bad: number = "wrong"'), FileCompileError);
  assert.throws(() => files.evaluate('count++; const history: string[] = [];'), /Cannot redeclare block-scoped variable 'history'/);
  assert.equal(files.scope.list().some((definition) => definition.name === "history"), false);
  assert.equal(files.evaluate("count").value, 0);
  assert.throws(() => files.evaluate('const good = 7; throw new Error("boom"); const later = 9;'), /boom/);
  assert.equal(files.evaluate("good").value, 7);
  assert.throws(() => files.evaluate("later"), /Cannot find name/);
  assert.throws(() => files.evaluate("await Promise.resolve(1);"), /cannot await/);
  files.scope.clear();
  assert.equal(files.scope.list().length, 0);
  assert.throws(() => files.evaluate("good"), /Cannot find name/);
});

test("a waiting model coroutine leaves the same instance open to later control files", async (t) => {
  const f = fixture(t);
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.faux.setResponses([async () => {
    entered();
    await gate;
    return fauxAssistantMessage(fauxToolCall("submit", { value: { text: "Hello" } }), { stopReason: "toolUse" });
  }]);
  f.files.runFile(f.file("start.ts", `
    import { defineFunction } from "@bitagent/core";
    import { answer } from "@bitagent/core/skills";
    const translate = defineFunction<(text: string) => {text: string}>(function* (result, text) {
      return yield* answer(llm, result, {prompt:text, system:"Use submit", maxAttempts:2});
    });
    let completed = false;
    const job = app.start(function* () {
      const value = yield* translate("hello");
      completed = true;
      return value;
    });
  `));
  await started;
  assert.equal(f.files.evaluate("completed").value, false);
  assert.equal(f.files.evaluate("job.state.status").value, "waiting");
  const probe = f.files.runFile(f.file("control.ts", "const another = app.start(function* () { return 42; }); another;"));
  assert.deepEqual(await waitForTask(probe.value), { status: "succeeded", value: 42 });
  const job = f.files.evaluate("job").value;
  release();
  assert.deepEqual(await waitForTask(job), { status: "succeeded", value: { text: "Hello" } });
  assert.equal(f.files.evaluate("completed").value, true);
  f.files.scope.clear();
  assert.equal(f.app.list().includes(job), true);
  assert.equal(job.state.status, "succeeded");
});

test("checked relative imports and type-only imports survive into later files", (t) => {
  const f = fixture(t);
  f.file("helper.ts", `
    export interface Constraint { name: string }
    export interface Named<T extends Constraint = Constraint> {name: string; detail?: T}
    export class Thing<T> { constructor(readonly value: T) {} }
    export function twice(n: number) {return n * 2}
  `);
  f.files.runFile(f.file("import.ts", `
    import { twice } from "./helper.js";
    import type { Named, Thing, twice as typeTwice } from "./helper.js";
    import type * as Types from "./helper.js";
    const named: Named = { name: "ok" };
    twice(3);
  `));
  assert.equal(f.files.evaluate("twice(4)").value, 8);
  // Changing the source must not change the type snapshot of an executed file.
  f.file("helper.ts", "export interface Named { name: number }");
  const editor = editorProgram(f, `
    const value: Named = {name: "typed"}; named.name.toUpperCase(); twice(3);
    const thing: Thing<number> = {value:1};
    const namespaceThing: Types.Thing<number> = thing;
    let constructor: typeof Types.Thing;
    let typeFunction: typeof typeTwice;
    // @ts-expect-error type-only imports do not acquire a runtime constructor
    new Thing<number>(1);
    // @ts-expect-error original generic constraints remain enforced
    const invalid: Named<string> = {name:"wrong"};
    // @ts-expect-error type-only namespaces have no runtime value
    new Types.Thing<number>(1);
    // @ts-expect-error type-only functions cannot be called
    typeTwice(2);
  `);
  assert.equal(editor.diagnostics.length, 0, diagnosticText(editor.diagnostics));
  assert.throws(() => f.files.evaluate("typeTwice(2)"), /imported using 'import type'/);
  assert.throws(() => f.files.evaluate("Types.twice(2)"), /imported using 'import type'/);
});

test("merged declarations retain one stable handle", (t) => {
  const f = fixture(t);
  const result = f.files.evaluate("namespace M {export const a = 1}; namespace M {export const b = 2}");
  assert.equal(result.definitions.length, 1);
  assert.equal(result.definitions[0], f.files.scope.list()[0]);
  assert.equal(f.files.evaluate("M.a + M.b").value, 3);
  assert.equal(f.files.scope.forget(result.definitions[0]), true);
});

test("one declaration surface belongs to one instance and closes explicitly", (t) => {
  const f = fixture(t);
  assert.throws(() => createFileSession({ app: f.app, llm: f.llm, cwd: f.cwd }), /another session/);
  const unrelated = fixture(t);
  f.files.evaluate("const unique = 1");
  const handle = f.files.scope.list()[0];
  assert.equal(unrelated.files.scope.forget(handle), false);
  f.files.close();
  assert.equal(readFileSync(f.files.declarationsPath, "utf8").includes("unique"), false);
  assert.equal(f.files.scope.list()[0], handle);
  assert.throws(() => f.files.evaluate("1"), /closed/);
  const reopened = createFileSession({ app: f.app, llm: f.llm, cwd: f.cwd });
  reopened.close();
  assert.equal(readFileSync(f.files.declarationsPath, "utf8").includes("unique"), false);
});
