import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApplication } from "../src/index.js";
import type { TextGenerator } from "../src/index.js";
import { createScriptConsole, ScriptCompileError } from "../src/node/index.js";

const llm: TextGenerator = {
  async generate({ prompt }) { return { text: prompt, finishReason: "stop" }; },
};

async function fixture() {
  const app = createApplication();
  const scripts = await createScriptConsole({ app, llm });
  return { app, scripts };
}

test("variables, functions, top-level await, and typed imports persist across snippets", async () => {
  const { scripts } = await fixture();
  await scripts.evaluate("const count: number = 3; function twice(n: number) { return n * 2; }");
  assert.equal((await scripts.evaluate("twice(count)")).value, 6);
  await scripts.evaluate("const after = await Promise.resolve(7);");
  assert.equal((await scripts.evaluate("twice(after)")).value, 14);
  await scripts.evaluate('import { basename } from "node:path";');
  assert.equal((await scripts.evaluate('basename("/a/b")')).value, "b");
  await assert.rejects(scripts.evaluate("twice('wrong')"), ScriptCompileError);
});

test("type errors block the whole snippet and do not poison later evaluations", async () => {
  const { app, scripts } = await fixture();
  await scripts.evaluate("let count = 0;");
  await assert.rejects(scripts.evaluate('count = 99; app.start(() => 1); const wrong: number = "bad";'), ScriptCompileError);
  assert.equal(app.list().length, 0);
  assert.equal((await scripts.evaluate("count")).value, 0);
  await scripts.evaluate("const wrong: number = 2;");
  assert.equal((await scripts.evaluate("wrong")).value, 2);
  await assert.rejects(scripts.evaluate('llm.generate({ prompt: 42 })'), ScriptCompileError);
});

test("top-level await never excuses a type error or replays an earlier snippet", async () => {
  const { scripts } = await fixture();
  await scripts.evaluate(
    'let executions = 0; const loading = import("node:path").then(path => {' +
    'executions += 1; return path.basename("/a/b"); });',
  );
  await scripts.evaluate("const loaded = await loading;");
  assert.equal((await scripts.evaluate("loaded")).value, "b");
  assert.equal((await scripts.evaluate("executions")).value, 1);
  await assert.rejects(
    scripts.evaluate('executions = 99; const bad: number = "bad"; await Promise.resolve();'),
    ScriptCompileError,
  );
  assert.equal((await scripts.evaluate("executions")).value, 1);
});

test("ordinary skills import through the public package with their types intact", async () => {
  const { scripts } = await fixture();
  await scripts.evaluate('import { summarize } from "@bitagent/core/skills";');
  const result = await scripts.evaluate(
    'const summary = await summarize(llm, { text: "input", instruction: "do it" }); summary.text',
  );
  assert.equal(result.value, "input");
  await assert.rejects(
    scripts.evaluate('summarize(llm, { text: 42, instruction: "do it" })'),
    ScriptCompileError,
  );
});

test("a later snippet controls the same live run without retaining the starting script", async () => {
  const { app, scripts } = await fixture();
  await scripts.evaluate(
    "const hold: { release?: () => void } = {};" +
    "const run = app.start(async ({ signal }) => {" +
    "await new Promise<void>(resolve => { hold.release = resolve; });" +
    "signal.throwIfAborted(); return 42; });",
  );
  assert.equal(app.list()[0]?.state.status, "running");
  assert.equal((await scripts.evaluate("run.cancel() ")).value, true);
  assert.equal(app.list()[0]?.state.status, "cancelling");
  await scripts.evaluate("hold.release?.(); await run.done;");
  assert.equal(app.list()[0]?.state.status, "cancelled");
});

test("reset drops definitions, keeps the same application, and does not cancel its work", async () => {
  const { app, scripts } = await fixture();
  const run = app.start(() => 42);
  await run.done;
  await scripts.evaluate("const previous = 3;");
  await scripts.reset();
  await assert.rejects(scripts.evaluate("previous"), ScriptCompileError);
  assert.equal((await scripts.evaluate("app.list().length")).value, 1);
  assert.equal(app.list()[0], run);
  assert.equal(run.state.status, "succeeded");
  await scripts.evaluate("const previous = 4;");
});

test("queued snippets serialize even across top-level await, and recover after runtime errors", async () => {
  const { scripts } = await fixture();
  const first = scripts.evaluate("let order = 0; await new Promise(r => setTimeout(r, 10)); order = 1;");
  const second = scripts.evaluate("order += 1; order");
  await first;
  assert.equal((await second).value, 2);
  await assert.rejects(scripts.evaluate('order = 3; throw new Error("boom");'), /boom/);
  assert.equal((await scripts.evaluate("order")).value, 3);
  await assert.rejects(scripts.evaluate("throw null"), (error) => error === null);
});

test("returned promises are values unless the user explicitly awaits them", async () => {
  const { scripts } = await fixture();
  const result = await scripts.evaluate("Promise.resolve(42)");
  assert.equal(await result.value, 42);
  assert.notEqual(result.value, 42);
});

test("separate consoles isolate definitions and honor a caller-selected import directory", async () => {
  const { scripts: left } = await fixture();
  await left.evaluate("const privateValue = 1;");
  const app = createApplication();
  const right = await createScriptConsole({ app, llm, cwd: fileURLToPath(new URL("../src/skills/", import.meta.url)) });
  await assert.rejects(right.evaluate("privateValue"), ScriptCompileError);
  await right.evaluate('import { summarize } from "./index.js";');
  assert.equal((await right.evaluate('const result = await summarize(llm, { text: "input", instruction: "do it" }); result.text')).value, "input");
});
