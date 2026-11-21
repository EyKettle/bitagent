import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { compileConsumer } from "./compiler.mjs";

// A supplied target validates the local contract draft; ordinary runs use package exports.
const target = process.env.BITAGENT_JOB_TYPES_TARGET;
test("Job completion consumers preserve inference and reject known thenables", (t) => {
  const fixture = fileURLToPath(new URL("./fixtures/job-completion-consumer.ts", import.meta.url));
  const program = compileConsumer(fixture, target);
  const source = program.getSourceFile(fixture);
  const declaration = source.statements.find((statement) => ts.isImportDeclaration(statement)
    && statement.moduleSpecifier.text === "@bitagent/core");
  const name = declaration.importClause.namedBindings.elements.find((element) => element.name.text === "Job").name;
  const checker = program.getTypeChecker();
  const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(name));
  const files = [...new Set(symbol.declarations.map((node) => resolve(node.getSourceFile().fileName)))];
  const expected = target === undefined
    ? fileURLToPath(new URL("../../dist/runtime/jobs.d.ts", import.meta.url)) : resolve(target);
  assert.deepEqual(files, [expected]);
  t.diagnostic(JSON.stringify({ typescript: ts.version, declarations: files, consumer: fixture }));
});
