import { dirname, resolve } from "node:path";

import { bindingExports, bindingSetters, planBindings } from "./bindings.js";
import { diagnosticsFor, toDiagnostics } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import type { CheckedInput, EvaluatedInput, ExecutionContext, ExecutionResult } from "./execution.js";
import { preview } from "./preview.js";
import { createProgram } from "./program.js";
import { bindScope, rewriteMutableBindings } from "./scope-input.js";
import type { BatchScope, SourceInput } from "./scope.js";

export { ExecutionContext } from "./execution.js";
export type { ExecutionResult } from "./execution.js";
export type { Diagnostic } from "./diagnostics.js";
export type { BatchScope, Definition, SourceInput } from "./scope.js";

type Preparation = { kind: "checked"; input: CheckedInput } | { kind: "diagnostic"; diagnostics: Diagnostic[] };

export class TypeScriptCompiler {
  prepare(input: SourceInput, definitions?: BatchScope): Preparation {
    const scope = definitions && bindScope(input, definitions.bindings);
    const adopted = scope?.input ?? input;
    const initial = createProgram(adopted, scope?.imports);
    const diagnostics = diagnosticsFor(initial.program);
    if (diagnostics.length) return { kind: "diagnostic", diagnostics };

    const bindings = scope ? planBindings(initial.program, initial.entry, scope.sourceEnd, scope.prefix) : [];
    const source = bindings.length ? `${adopted.source}\n${bindingExports(bindings)}` : adopted.source;
    const { program, entry } = bindings.length
      ? createProgram({ ...adopted, source }, scope?.imports, initial.program)
      : initial;
    if (bindings.length) {
      diagnostics.push(...diagnosticsFor(program));
      if (diagnostics.length) return { kind: "diagnostic", diagnostics };
    }

    const { exportName, transform } = preview(entry, input.source.length);
    const before = scope?.mutable.size ? [rewriteMutableBindings(program, entry, scope), transform] : [transform];
    let code: string | undefined;
    const emitted = program.emit(entry, (_path, text) => { code = text; }, undefined, false, { before });
    diagnostics.push(...toDiagnostics("type", emitted.diagnostics));
    if (diagnostics.length) return { kind: "diagnostic", diagnostics };
    if (emitted.emitSkipped || code === undefined) throw new Error(`TypeScript did not emit ${entry.fileName}`);

    const checked: CheckedInput = { fileName: entry.fileName, code, previewExport: exportName };
    if (scope && definitions) {
      const specifier = `bitagent:${scope.prefix}`;
      const cellsSpecifier = `${specifier}cells`;
      checked.scope = {
        retained: scope.retained,
        cells: scope.mutable.size ? { specifier: cellsSpecifier, value: definitions.retainCells(scope.mutable.keys()) } : undefined,
        bindings,
        typeSource: { source, specifier, imports: scope.imports, fileName: resolve(dirname(entry.fileName), `${scope.prefix}scope.ts`) },
      };
      if (scope.mutable.size) checked.code += `\nimport ${scope.prefix}cells from ${JSON.stringify(cellsSpecifier)};`;
      checked.code += `\n${bindingSetters(bindings)}`;
    }
    return { kind: "checked", input: checked };
  }

  async execute(input: SourceInput, context: ExecutionContext): Promise<ExecutionResult> {
    return (await this.executeBatch(input, context)).result;
  }

  async executeBatch(input: SourceInput, context: ExecutionContext, scope?: BatchScope): Promise<EvaluatedInput> {
    try {
      const prepared = this.prepare(input, scope);
      return prepared.kind === "checked" ? await context.evaluate(prepared.input) : { result: prepared };
    } catch (error) {
      return { result: { kind: "execution-error", error } };
    }
  }
}
