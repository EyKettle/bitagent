import assert from "node:assert/strict";
import { resolve } from "node:path";
import ts from "typescript";

/** Strict portable consumers use built package exports unless a contract draft is supplied. */
export function compileConsumer(fixture, target) {
  const program = ts.createProgram([fixture], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true,
    exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    noEmit: true, skipLibCheck: true, types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    ...(target === undefined ? {} : { paths: {
      "@bitagent/core": [resolve(target)], "@bitagent/core/host": [resolve(target)],
    } }),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
  return program;
}
