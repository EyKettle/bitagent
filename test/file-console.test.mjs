import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import ts from "typescript";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createScheduler } from "@bitagent/core";
import { waitForTask } from "@bitagent/core/host";
import { createPiEntity } from "@bitagent/core/pi";
import { createFileSession, initializeFileWorkspace, runFileConsole } from "@bitagent/core/node";

function fixture(t) {
  mkdirSync(".build", { recursive: true });
  const cwd = mkdtempSync(resolve(".build", "file-console-"));
  mkdirSync(join(cwd, "node_modules", "@bitagent"), { recursive: true });
  symlinkSync(resolve("."), join(cwd, "node_modules", "@bitagent", "core"), "dir");
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  const workspace = initializeFileWorkspace(cwd);
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const app = createScheduler();
  const llm = createPiEntity(models, faux.getModel());
  const files = createFileSession({ app, llm, cwd });
  t.after(() => files.close());
  const file = (name, source) => { const path = join(cwd, name); writeFileSync(path, source); return path; };
  return { cwd, workspace, faux, app, llm, files, file };
}

function languageService(cwd, configPath) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
  assert.deepEqual(parsed.errors, []);
  return ts.createLanguageService({
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot(path) {
      const content = ts.sys.readFile(path);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => cwd,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  });
}

test("the ordinary editor gets live completions and strict diagnostics without overwriting config", (t) => {
  const f = fixture(t);
  assert.equal(f.workspace.created, true);
  const original = readFileSync(f.workspace.configPath, "utf8");
  assert.equal(initializeFileWorkspace(f.cwd).created, false);
  assert.equal(readFileSync(f.workspace.configPath, "utf8"), original);
  f.files.runFile(f.file("setup.ts", 'const item = {text:"retained"}; function double(n: number) {return n * 2}'));
  const source = 'const label: string = item.text; double("bad"); console.log(label);';
  const path = f.file("control.ts", source);
  const service = languageService(f.cwd, f.workspace.configPath);
  t.after(() => service.dispose());
  const completions = service.getCompletionsAtPosition(path, source.indexOf("item.") + "item.".length, {});
  assert.ok(completions?.entries.some((entry) => entry.name === "text"));
  const diagnostics = ts.getPreEmitDiagnostics(service.getProgram());
  assert.equal(diagnostics.length, 1, diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  assert.equal(diagnostics[0].code, 2345);
  assert.match(ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n"), /string.*number/);
  writeFileSync(f.workspace.configPath, '{"compilerOptions":{"strict":false}}\n');
  assert.equal(initializeFileWorkspace(f.cwd).created, false);
  assert.equal(readFileSync(f.workspace.configPath, "utf8"), '{"compilerOptions":{"strict":false}}\n');
});

test("file commands stay responsive while model work waits and leave shutdown to the host", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  f.faux.setResponses([async () => {
    entered.resolve();
    await gate.promise;
    return fauxAssistantMessage(fauxToolCall("submit", { value: { text: "Hello" } }), { stopReason: "toolUse" });
  }]);
  f.file("start work.ts", `
    import { defineFunction } from "@bitagent/core";
    import { answer } from "@bitagent/core/skills";
    const translate = defineFunction<(text: string) => {text: string}>(function* (result, text) {
      return yield* answer(llm, result, {prompt:text, system:"Use submit", maxAttempts:2});
    });
    let after = false;
    const job = app.start(function* () { const result = yield* translate("hello"); after = true; return result; });
  `);
  f.file("control.ts", 'const fast = app.start(function* () {return 42}); job.state.status + ":" + after;');
  const input = new PassThrough();
  const output = new PassThrough();
  const controlled = Promise.withResolvers();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
    if (text.includes("waiting:false")) controlled.resolve();
  });
  const loop = runFileConsole({ session: f.files, input, output });
  let job;
  try {
    input.write(".run start work.ts\n");
    await entered.promise;
    job = f.app.list()[0];
    assert.equal(job.state.status, "waiting");
    input.write(".run\n.run control.ts\n");
    await controlled.promise;
    assert.match(text, /Usage: \.run <path>/);
    assert.equal(f.app.list().length, 2);
    assert.deepEqual(await waitForTask(f.app.list()[1]), { status: "succeeded", value: 42 });
    input.end(".exit\n");
    await loop;
    assert.equal(job.state.status, "waiting");
    assert.ok(f.files.scope.list().some((definition) => definition.name === "job"));
  } finally {
    gate.resolve();
    input.end();
    await loop;
  }
  assert.deepEqual(await waitForTask(job), { status: "succeeded", value: { text: "Hello" } });
  assert.equal(f.llm.activeCalls, 0);
});
