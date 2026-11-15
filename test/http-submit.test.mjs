import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { ContractError, createScheduler } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { createFileSession, FileCompileError, initializeFileWorkspace } from "@bitagent/core/node";
import { createTranslator, SubmissionError } from "@bitagent/core/skills";
import { createMockEntity } from "../examples/mock-entity.mjs";
import { launchMock } from "./support/mock.mjs";

function workspace() {
  mkdirSync(".build", { recursive: true });
  const cwd = mkdtempSync(resolve(".build", "http-submit-"));
  mkdirSync(join(cwd, "node_modules", "@bitagent"), { recursive: true });
  symlinkSync(resolve("."), join(cwd, "node_modules", "@bitagent", "core"), "dir");
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  for (const name of ["start.ts", "inspect.ts", "wait.ts", "cancel.ts", "custom.ts"]) {
    copyFileSync(new URL("../examples/workspace/" + name, import.meta.url), join(cwd, name));
  }
  return cwd;
}

function trackedEntity(url) {
  const requests = [];
  const waiting = Promise.withResolvers();
  const llm = createMockEntity(url, {
    async fetch(input, init) {
      const request = new Request(input, init);
      const body = await request.clone().json();
      requests.push(body);
      const response = await globalThis.fetch(input, init);
      if (JSON.stringify(body).includes("[wait]")) waiting.resolve();
      return response;
    },
  });
  return { llm, requests, waiting: waiting.promise };
}

function fileSession(t, llm) {
  const cwd = workspace();
  initializeFileWorkspace(cwd);
  const app = createScheduler();
  const files = createFileSession({ app, llm, cwd });
  t.after(async () => {
    for (const task of app.list()) task.cancel();
    await Promise.all(app.list().map(waitForTask));
    files.close();
  });
  return { cwd, app, files };
}

test("file workflows use typed submit over the real Messages HTTP protocol", { timeout: 90000 }, async (t) => {
  const url = await launchMock(t, "submit");

  await t.test("official translation corrects a bad submit and ends history at the accepted call", async () => {
    const { llm, requests } = trackedEntity(url);
    const history = [];
    const translate = createTranslator(llm, { maxAttempts: 2, onMessage: (message) => history.push(message) });
    assert.throws(() => translate(42, "English"), ContractError);
    assert.equal(requests.length, 0);
    const app = createScheduler();
    const job = app.start(function* () {
      const result = yield* translate("你好", "English");
      assert.equal(llm.status, "idle");
      return result;
    });
    assert.deepEqual(await waitForTask(job), { status: "succeeded", value: { text: "Hello" } });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools[0].name, "submit");
    assert.equal(requests[0].tools[0].input_schema.properties.value.properties.text.type, "string");
    assert.match(JSON.stringify(requests[1].messages), /Invalid submission/);
    assert.match(JSON.stringify(requests[1].messages), /"is_error":true/);
    assert.doesNotMatch(JSON.stringify(history), /after_submit/);
    assert.equal(history.at(-1).role, "assistant");
    assert.equal(history.at(-1).content.at(-1).name, "submit");
    assert.equal(llm.activeCalls, 0);
  });

  await t.test("a user function's different return type determines its own submit schema", async (t) => {
    const { llm, requests } = trackedEntity(url);
    const { app, files } = fileSession(t, llm);
    files.runFile("custom.ts");
    assert.deepEqual(await waitForTask(app.list()[0]), { status: "succeeded", value: "example:2" });
    assert.equal(requests.length, 1);
    const schema = requests[0].tools[0].input_schema.properties.value;
    assert.equal(schema.properties.label.type, "string");
    assert.equal(schema.properties.items.type, "number");
    assert.throws(() => files.evaluate("classify(42)"), FileCompileError);
    assert.equal(requests.length, 1);
  });

  await t.test("a second file can control an actual stalled HTTP call without early continuation", async (t) => {
    const { llm, waiting } = trackedEntity(url);
    const { cwd, app, files } = fileSession(t, llm);
    files.runFile("start.ts");
    assert.equal((await waitForTask(app.list()[0])).status, "succeeded");
    files.runFile("wait.ts");
    const waitingJob = app.list()[1];
    await waiting;
    assert.equal(waitingJob.state.status, "waiting");
    writeFileSync(join(cwd, "control.ts"), `
      const fast = app.start(function* () { return 42; });
      waitingJob.state.status + ":" + waitingCompleted;
    `);
    assert.equal(files.runFile("control.ts").value, "waiting:false");
    assert.deepEqual(await waitForTask(app.list()[2]), { status: "succeeded", value: 42 });
    assert.equal(files.runFile("cancel.ts").value.status, "cancelling");
    assert.equal((await waitForTask(waitingJob)).status, "cancelled");
    assert.equal(files.evaluate("waitingCompleted").value, false);
    assert.equal(llm.status, "idle");
    const configPath = join(cwd, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
    assert.deepEqual(parsed.errors, []);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
  });

  await t.test("invalid submissions are bounded and transport errors are not blindly retried", async () => {
    const { llm, requests } = trackedEntity(url);
    const app = createScheduler();
    const translate = createTranslator(llm, { maxAttempts: 2 });
    const invalid = await waitForTask(app.start(() => translate("[invalid]", "English")));
    assert.equal(invalid.status, "failed");
    assert.ok(invalid.error instanceof SubmissionError);
    assert.match(invalid.error.message, /after 2 attempts/);
    assert.equal(requests.length, 2);
    const failed = await waitForTask(app.start(() => translate("[error]", "English")));
    assert.equal(failed.status, "failed");
    assert.ok(failed.error instanceof SubmissionError);
    assert.equal(requests.length, 3);
    assert.equal(llm.status, "idle");
  });

  await t.test("the CLI with an explicit workspace retains state and joins cancellation on exit", { timeout: 40000 }, async (t) => {
    const cwd = workspace();
    writeFileSync(join(cwd, "observe.ts"), `
      const observer = app.start(function* () {
        const result = yield* job.join();
        console.log("CLI_RESULT", result.text);
      });
    `);
    writeFileSync(join(cwd, "closing.ts"), `
      import { createTranslator } from "@bitagent/core/skills";
      const translate = createTranslator(llm, {maxAttempts:2});
      const closing = app.start(function* () {
        console.log("CLI_WAITING");
        try { return yield* translate("[wait]", "English"); }
        finally { console.log("CLI_CLEANUP"); }
      });
    `);
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../examples/console.mjs", import.meta.url)), "--cwd", cwd, "--base-url", url,
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    const listeners = new Set();
    child.stdout.on("data", (chunk) => { output += chunk; for (const listener of listeners) listener(); });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timeout); }
    });
    function until(text) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cleanup(); reject(new Error("CLI did not print " + text + "\n" + output + errors)); }, 20000);
        const observe = () => { if (output.includes(text)) { cleanup(); resolve(); } };
        const closed = (code) => { cleanup(); reject(new Error("CLI exited " + code + " before " + text + "\n" + output + errors)); };
        function cleanup() { clearTimeout(timeout); listeners.delete(observe); child.off("close", closed); }
        listeners.add(observe);
        child.once("close", closed);
        observe();
      });
    }
    child.stdin.write(".run start.ts\n.run observe.ts\n");
    await until("CLI_RESULT Hello");
    child.stdin.write('.run inspect.ts\n.clear\ncompleted\nconsole.log("CLI_AFTER_CLEAR", app.list().length);\n.run closing.ts\n');
    await until("CLI_WAITING");
    child.stdin.end(".exit\n");
    assert.equal(await exited, 0, output + errors);
    assert.match(output, /completed: true/);
    assert.match(output, /Cannot find name 'completed'/);
    assert.match(output, /CLI_AFTER_CLEAR 2/);
    assert.match(output, /CLI_CLEANUP/);
    assert.equal(errors, "");
    assert.equal(existsSync(join(cwd, ".bitagent", "session.lock")), false);
    assert.match(readFileSync(join(cwd, ".bitagent", "globals.d.ts"), "utf8"), /No live editor connection/);
  });
});
