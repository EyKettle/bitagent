import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";
import { launchMock } from "./support/mock.mjs";

const run = promisify(execFile);

/** Preserve the repository's package scope, not a separate --cwd consumer package. */
function repository() {
  mkdirSync(".build", { recursive: true });
  const root = mkdtempSync(resolve(".build", "default-console-"));
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.build.json"]) {
    copyFileSync(new URL("../" + name, import.meta.url), join(root, name));
  }
  cpSync(new URL("../src/", import.meta.url), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dev"));
  copyFileSync(new URL("../dev/build-contracts.mjs", import.meta.url), join(root, "dev", "build-contracts.mjs"));
  const workspace = join(root, "examples", "workspace");
  mkdirSync(workspace, { recursive: true });
  for (const name of ["console.mjs", "mock-entity.mjs"]) {
    copyFileSync(new URL("../examples/" + name, import.meta.url), join(root, "examples", name));
  }
  for (const name of ["start.ts", "inspect.ts", "wait.ts", "cancel.ts", "custom.ts"]) {
    copyFileSync(new URL("../examples/workspace/" + name, import.meta.url), join(workspace, name));
  }
  return { root, workspace };
}

test("pnpm run console uses the default repository workspace without --cwd", { timeout: 180000 }, async (t) => {
  const { root, workspace } = repository();
  assert.equal(existsSync(join(workspace, "package.json")), false);
  assert.equal(existsSync(join(workspace, "tsconfig.json")), false);
  // The normal test prerequisite installed this lockfile. Reuse its cached
  // packages without linking the test's runtime back to the working tree.
  await run("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: root, timeout: 60000 });
  const url = await launchMock(t, "submit");
  writeFileSync(join(workspace, "observe.ts"), `
    const observer = app.start(function* () {
      const result = yield* job.join();
      console.log("DEFAULT_RESULT", result.text);
    });
  `);
  mkdirSync(join(root, "examples", "shared"));
  writeFileSync(join(root, "examples", "shared", "multiply.ts"),
    "export function multiply(value: number) { return value * 6; }\n");
  writeFileSync(join(workspace, "outside.ts"), `
    import { multiply } from "../shared/multiply.js";
    const outsideResult = multiply(7);
    let touches = 0;
    console.log("DEFAULT_OUTSIDE", outsideResult);
  `);
  writeFileSync(join(workspace, "invalid.ts"), 'touches++; multiply("wrong");\n');

  // Override only the HTTP endpoint, never the default workspace or entry script.
  const child = spawn("pnpm", ["run", "console", "--base-url", url], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  child.stdout.on("data", (chunk) => { output += chunk; notify(); });
  child.stderr.on("data", (chunk) => { errors += chunk; notify(); });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end(".exit\n");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timeout); }
  });
  function until(marker) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timeout);
        listeners.delete(observe);
        child.off("close", closed);
        if (error) reject(error); else resolve();
      };
      const failure = () => new Error("Default console did not produce " + marker + "\n" + output + errors);
      const observe = () => {
        if (/TS2209/.test(output + errors)) finish(failure());
        else if (output.includes(marker)) finish();
      };
      const closed = () => finish(failure());
      const timeout = setTimeout(() => finish(failure()), 40000);
      listeners.add(observe);
      child.once("close", closed);
      observe();
    });
  }

  child.stdin.write(".run start.ts\n.run observe.ts\n");
  await until("DEFAULT_RESULT Hello");
  child.stdin.write(".run outside.ts\n");
  await until("DEFAULT_OUTSIDE 42");
  child.stdin.write('.run invalid.ts\n.run inspect.ts\nconsole.log("DEFAULT_RETAINED", completed, touches, outsideResult);\n');
  await until("DEFAULT_RETAINED true 0 42");
  child.stdin.end(".exit\n");
  assert.equal(await exited, 0, output + errors);
  // pnpm writes the command lines it runs to stderr; judge the executable
  // results and diagnostics rather than requiring an empty script-runner log.
  const text = stripVTControlCharacters(output + errors);
  assert.ok(text.includes("BitAgent file session: " + workspace), text);
  assert.match(text, /Argument of type 'string' is not assignable to parameter of type 'number'/);
  assert.match(text, /completed: true/);
  assert.doesNotMatch(text, /TS2209|TS6059|ENOENT/);
  assert.equal(existsSync(join(workspace, "package.json")), false);
  assert.equal(existsSync(join(workspace, ".bitagent", "session.lock")), false);
  assert.match(readFileSync(join(workspace, ".bitagent", "globals.d.ts"), "utf8"), /No live editor connection/);
});
