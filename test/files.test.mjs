import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Application } from "../dist/context/application/index.js";
import { prepareStageOne } from "./fixtures/stage-one/prepare.mjs";

const entry = fileURLToPath(new URL("../dist/interface/console/index.js", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bitagent-stage-one-test-"));
  t.after(() => rmSync(root, { recursive: true }));
  return prepareStageOne(root);
}

function run(workspace, lines) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--experimental-import-meta-resolve", entry, "--workspace", workspace,
  ], { input: [...lines, ""].join("\n"), encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function errors(stderr) {
  return stderr.split("\n").filter((line) => /^(?:syntax |type |Execution error:)/u.test(line));
}

test("native workspace imports isolate locals, preserve live exports and do not evaluate a rejected graph", (t) => {
  const { workspace } = fixture(t);
  const { stdout, stderr } = run(workspace, [
    'import { amount, increment, type WorkspaceAmount } from "./live.ts"; amount;',
    'import { amount as same } from "./live.js"; const before: WorkspaceAmount = same; before;',
    "increment()",
    "[amount, same]",
    'const location = "./live.ts"; (await import(location)).amount;',
    '(await import("./live.ts")).amount;',
    "moduleLocal",
    'import { wrong } from "./invalid.ts"; wrong;',
    "amount + 40",
  ]);
  assert.equal(stdout, "workspace evaluated\n4\n4\n5\n[ 5, 5 ]\n5\n5\n45\n");
  const diagnostics = errors(stderr);
  assert.equal(diagnostics.length, 2, stderr);
  assert.match(diagnostics[0], /type TS2304 .*Cannot find name 'moduleLocal'/u);
  assert.match(diagnostics[1], /type TS2322 .*invalid\.ts:4:14.*Type 'string'/u);
});

test("explicit scripts are inert until run, and successful runs share live Console definitions", (t) => {
  const { workspace, foreign } = fixture(t);
  const batch = join(foreign, "batch.ts");
  const invalid = join(foreign, "invalid.ts");
  const { stdout, stderr } = run(workspace, [
    "let counter: number = 5; function prior() { return counter; }",
    `.file ${batch}`,
    "prior()",
    ".run",
    "[prior(), counter, scriptRead(), scriptResult]",
    "counter = 9; scriptRead()",
    `.file ${invalid}`,
    ".run",
    "counter",
  ]);
  assert.equal(stdout, [
    `Acquired ${batch}`, "5", "script saw 5", "16", "[ 8, 8, 8, 16 ]", "9", `Acquired ${invalid}`, "9", "",
  ].join("\n"));
  assert.equal(errors(stderr).length, 1, stderr);
  assert.match(stderr, /type TS2322 .*invalid\.ts:3:7.*Type 'string'/u);
});

test("dependency lookup for an external script is anchored in the selected project", (t) => {
  const { workspace, foreign, configured } = fixture(t);
  const script = join(foreign, "dependency.ts");
  const lines = [`.file ${script}`, ".run", "42"];
  const denied = run(workspace, lines);
  assert.equal(denied.stdout, `Acquired ${script}\n42\n`);
  assert.equal(errors(denied.stderr).length, 1, denied.stderr);
  assert.match(denied.stderr, /type TS2307 .*dependency\.ts:1:24.*Cannot find module 'stage-one-conditional'/u);
  const allowed = run(configured, [`.file ${script}`, ".run", "origin", "42"]);
  assert.equal(allowed.stdout, `Acquired ${script}\npackage evaluated\ndependency: configured project\nundefined\n'configured project'\n42\n`);
  assert.deepEqual(errors(allowed.stderr), []);

  const resolved = run(configured, ['(await import(import.meta.resolve("stage-one-conditional"))).origin;']);
  assert.equal(resolved.stdout, "package evaluated\n'configured project'\n");
  assert.deepEqual(errors(resolved.stderr), []);
});

test("an acquired handle runs the immutable source in its owning application", async (t) => {
  const { workspace, foreign } = fixture(t);
  const path = join(foreign, "snapshot.mts");
  writeFileSync(path, "const snapshot = 1; [snapshot, import.meta.dirname, import.meta.filename];\n");
  const owner = new Application({ workspace });
  const other = new Application({ workspace });
  const file = await owner.acquireFile(path);
  assert.equal(file.fileName, path);
  writeFileSync(path, "throw new Error('changed after acquisition');\n");
  assert.equal((await other.runFile(file)).kind, "execution-error");
  const executed = await owner.runFile(file);
  assert.equal(executed.kind, "success");
  assert.equal(executed.hasValue, true);
  assert.deepEqual(Array.from(executed.value), [1, foreign, path]);
  assert.deepEqual(await owner.submit("snapshot"), { kind: "success", hasValue: true, value: 1 });
});

test("a retained function's lazy import keeps its checked source and type", async (t) => {
  const { workspace } = fixture(t);
  const path = join(workspace, "lazy.ts");
  const app = new Application({ workspace });
  writeFileSync(path, 'Reflect.set(globalThis, "lazyEffect", true); export const value: number = 42;');
  assert.deepEqual(await app.submit('async function later() { return (await import("./lazy.ts")).value; }'),
    { kind: "success", hasValue: false });
  assert.deepEqual(await app.submit('Reflect.has(globalThis, "lazyEffect")'),
    { kind: "success", hasValue: true, value: false });
  writeFileSync(path, 'export const value = "different";');
  assert.deepEqual(await app.submit("const checked: number = await later(); checked;"),
    { kind: "success", hasValue: true, value: 42 });
  assert.deepEqual(await app.submit('Reflect.has(globalThis, "lazyEffect")'),
    { kind: "success", hasValue: true, value: true });
});

test("a native import of the same path stays distinct from an explicit batch", async (t) => {
  const { workspace } = fixture(t);
  const path = join(workspace, "entry.ts");
  writeFileSync(path, 'import { read } from "./dependent.ts"; export let amount = 2; read();');
  writeFileSync(join(workspace, "dependent.ts"), 'import { amount } from "./entry.ts"; export function read() { return amount; }');
  const app = new Application({ workspace });
  assert.deepEqual(await app.runFile(await app.acquireFile(path)), { kind: "success", hasValue: true, value: 2 });
  assert.deepEqual(await app.submit("amount = 9; read();"), { kind: "success", hasValue: true, value: 2 });
  assert.deepEqual(await app.submit("amount"), { kind: "success", hasValue: true, value: 9 });
});

test("project checking and execution select the same Node export conditions", (t) => {
  const { configured } = fixture(t);
  const pkg = join(configured, "node_modules", "stage-one-conditional");
  const conditions = {};
  for (const [condition, value] of [["node", 41], ["node-addons", 42], ["module-sync", 43]]) {
    const declarations = `${condition}.d.mts`;
    const entry = `${condition}.mjs`;
    writeFileSync(join(pkg, declarations), "export const target: number;\n");
    writeFileSync(join(pkg, entry), `export const target = ${value};\n`);
    conditions[`./${condition}`] = {
      [condition]: { types: `./${declarations}`, default: `./${entry}` },
      default: { types: "./index.d.mts", default: "./import.mjs" },
    };
  }
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "stage-one-conditional", type: "module", exports: conditions }));
  const result = run(configured, [
    'import { target as node } from "stage-one-conditional/node"; import { target as addon } from "stage-one-conditional/node-addons"; import { target as sync } from "stage-one-conditional/module-sync"; const targets: number[] = [node, addon, sync]; targets;',
  ]);
  assert.equal(result.stdout, "[ 41, 42, 43 ]\n", result.stderr);
  assert.deepEqual(errors(result.stderr), []);
});

test("a checked workspace module can load actual JavaScript without overwriting its source", (t) => {
  const { workspace } = fixture(t);
  const source = "export const local = 42;\n";
  const jsFile = join(workspace, "ordinary.mjs");
  writeFileSync(jsFile, source);
  writeFileSync(join(workspace, "consumer.ts"), 'export { local } from "./ordinary.mjs";\n');
  const result = run(workspace, ['import { local } from "./consumer.ts"; const value: number = local; value;']);
  assert.equal(result.stdout, "42\n", result.stderr);
  assert.deepEqual(errors(result.stderr), []);
  assert.equal(readFileSync(jsFile, "utf8"), source);
});

test("project packages join native evaluation order and preserve their export semantics", (t) => {
  const { workspace, configured } = fixture(t);
  cpSync(join(workspace, "live.ts"), join(configured, "live.ts"));
  cpSync(join(workspace, "cycle.ts"), join(configured, "cycle.ts"));
  const pkg = join(configured, "node_modules", "stage-one-conditional");
  writeFileSync(join(pkg, "index.d.mts"), "export let rank: number; export function move(): void;\n");
  writeFileSync(join(pkg, "nested.mjs"), 'export let rank = 1; export function move() { rank++; }\n');
  writeFileSync(join(pkg, "import.mjs"), 'export { rank, move } from "./nested.mjs"; console.log("ESM evaluated");\n');
  const commonjs = join(configured, "node_modules", "stage-one-commonjs");
  mkdirSync(commonjs);
  writeFileSync(join(configured, "package.json"), JSON.stringify({
    type: "module", dependencies: { "stage-one-commonjs": "1.0.0", "stage-one-conditional": "1.0.0" },
  }));
  writeFileSync(join(commonjs, "package.json"), JSON.stringify({
    name: "stage-one-commonjs", type: "commonjs", exports: { types: "./index.d.cts", default: "./index.cjs" },
  }));
  writeFileSync(join(commonjs, "index.d.cts"), "export const rank: number; export const missing: number;\n");
  writeFileSync(join(commonjs, "index.cjs"), 'console.log("CJS evaluated"); exports.rank = 7;\n');

  const linked = run(configured, [
    'import { amount } from "./live.ts"; import { missing } from "stage-one-commonjs"; amount + missing;',
    "40 + 2",
    'import { amount } from "./live.ts"; import { rank, move } from "stage-one-conditional"; import { rank as cjsRank } from "stage-one-commonjs"; [amount, rank, cjsRank];',
    "move(); rank;",
    '(await import(import.meta.resolve("stage-one-conditional"))).rank;',
  ]);
  assert.equal(linked.stdout, "42\nworkspace evaluated\nESM evaluated\nCJS evaluated\n[ 4, 1, 7 ]\n2\n2\n", linked.stderr);
  assert.equal(errors(linked.stderr).length, 1, linked.stderr);
  assert.match(linked.stderr, /Execution error: SyntaxError: .*does not provide an export named 'missing'/u);
});
