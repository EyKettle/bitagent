import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createScheduler, ContractError } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { compileContractProject, ContractCompileError } from "@bitagent/core/node";

async function project(source) {
  await mkdir(".build", { recursive: true });
  const root = await mkdtemp(resolve(".build", "contract-"));
  await mkdir(join(root, "node_modules", "@bitagent"), { recursive: true });
  await symlink(resolve("."), join(root, "node_modules", "@bitagent", "core"), "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      exactOptionalPropertyTypes: true, skipLibCheck: true, declaration: true, outDir: "out", types: [],
    },
    files: ["skill.ts"],
  }));
  await writeFile(join(root, "skill.ts"), source);
  return {
    root,
    compile() { compileContractProject(join(root, "tsconfig.json")); },
    load() { return import(pathToFileURL(join(root, "out", "skill.js")).href); },
  };
}

const prelude = 'import { defineFunction, type Coroutine } from "@bitagent/core";\n';

test("a normal user package compiles one signature into runtime input and result contracts", async () => {
  const fixture = await project(prelude + `
    interface Translation { text: string; language: "en" | "zh"; notes?: string[]; }
    type Translate = (text: string, language?: "en" | "zh") => Translation;
    export const translate = defineFunction<Translate>(function* (result, text, language = "en") {
      return result.parse({ text, language });
    });
    export const incorrect = defineFunction<() => Translation>(function* () {
      return JSON.parse('{"text":42,"language":"en"}');
    });
    function typeChecks() {
      // @ts-expect-error no implicit argument coercion
      translate(42);
      const task = translate("hello");
      // @ts-expect-error a coroutine is not a Promise
      task.then;
      function* consumer(): Coroutine<void> {
        const value = yield* task;
        value.text.toUpperCase();
        // @ts-expect-error result follows the declared signature
        value.missing;
      }
      void consumer;
    }
    void typeChecks;
  `);
  fixture.compile();
  const source = await readFile(join(fixture.root, "out", "skill.js"), "utf8");
  assert.match(source, /"parameters"/);
  assert.match(source, /"output"/);
  const skill = await fixture.load();
  const scheduler = createScheduler();
  assert.deepEqual(await waitForTask(scheduler.start(() => skill.translate("hello"))), {
    status: "succeeded", value: { text: "hello", language: "en" },
  });
  assert.throws(() => skill.translate(42), ContractError);
  assert.throws(() => skill.translate("ok", "de"), ContractError);
  const failed = await waitForTask(scheduler.start(() => skill.incorrect()));
  assert.equal(failed.status, "failed");
  assert.ok(failed.error instanceof ContractError);
});

test("compiled contracts snapshot structured arguments before coroutine scheduling", async () => {
  const fixture = await project(prelude + `
    type Echo = (input: { value: string }) => { value: string };
    export const echo = defineFunction<Echo>(function* (_result, input) { return input; });
  `);
  fixture.compile();
  const skill = await fixture.load();
  const input = { value: "original" };
  const work = skill.echo(input);
  input.value = "changed";
  assert.deepEqual(await waitForTask(createScheduler().start(() => work)), { status: "succeeded", value: { value: "original" } });
});

test("ordinary data contracts retain unions, recursive records, and readonly tuples", async () => {
  const fixture = await project(prelude + `
    type Tree = { name: string; children?: Tree[] };
    type Result = { kind: "tree"; root: Tree } | { kind: "pair"; pair: readonly [string, number] };
    export const echo = defineFunction<(value: Result) => Result>(function* (_result, value) { return value; });
  `);
  fixture.compile();
  const skill = await fixture.load();
  const scheduler = createScheduler();
  for (const value of [
    { kind: "tree", root: { name: "root", children: [{ name: "leaf" }] } },
    { kind: "pair", pair: ["x", 2] },
  ]) {
    assert.deepEqual(await waitForTask(scheduler.start(() => skill.echo(value))), { status: "succeeded", value });
  }
  assert.throws(() => skill.echo({ kind: "pair", pair: ["x", "wrong"] }), ContractError);
});

test("unsupported model return types fail compilation before any file is emitted or code loaded", async () => {
  for (const type of ["Date", "Promise<string>", "unknown", "any", "bigint", "() => string"]) {
    const fixture = await project(prelude + `
      export const unsupported = defineFunction<() => ${type}>(function* () { throw new Error("not run"); });
    `);
    assert.throws(() => fixture.compile(), ContractCompileError, type);
    await assert.rejects(readFile(join(fixture.root, "out", "skill.js")), { code: "ENOENT" });
  }
});

test("ordinary TypeScript stays unrestricted and compilation errors reject the whole project", async () => {
  const ordinary = await project('export function today(): Date { return new Date(0); }');
  ordinary.compile();
  const module = await ordinary.load();
  assert.equal(module.today().getTime(), 0);
  const invalid = await project(prelude + `
    export const accepted = defineFunction<() => string>(function* () { return "ok"; });
    const wrong: number = "not a number";
    export { wrong };
  `);
  assert.throws(() => invalid.compile(), /not assignable/);
  await assert.rejects(readFile(join(invalid.root, "out", "skill.js")), { code: "ENOENT" });
});
