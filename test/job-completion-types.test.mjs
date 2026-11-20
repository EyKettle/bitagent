import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

// A supplied target validates the local contract draft; ordinary runs use package exports.
const target = process.env.BITAGENT_JOB_TYPES_TARGET;
test("Job completion consumers preserve inference and reject known thenables", (t) => {
  const fixture = fileURLToPath(new URL("../dev/fixtures/job-completion-consumer.ts", import.meta.url));
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    noEmit: true, skipLibCheck: true, types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    ...(target === undefined ? {} : { paths: {
      "@bitagent/core": [resolve(target)], "@bitagent/core/host": [resolve(target)],
    } }),
  };
  const program = ts.createProgram([fixture], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
  const source = program.getSourceFile(fixture);
  const declaration = source.statements.find((statement) => ts.isImportDeclaration(statement)
    && statement.moduleSpecifier.text === "@bitagent/core");
  const name = declaration.importClause.namedBindings.elements.find((element) => element.name.text === "Job").name;
  const checker = program.getTypeChecker();
  const symbol = checker.getAliasedSymbol(checker.getSymbolAtLocation(name));
  const files = [...new Set(symbol.declarations.map((node) => resolve(node.getSourceFile().fileName)))];
  const expected = target === undefined
    ? fileURLToPath(new URL("../dist/runtime/jobs.d.ts", import.meta.url)) : resolve(target);
  assert.deepEqual(files, [expected]);
  t.diagnostic(JSON.stringify({ typescript: ts.version, declarations: files, consumer: fixture }));
});
