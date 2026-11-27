import { diagnosticsFor, toDiagnostics } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import type { CheckedInput, ExecutionContext, ExecutionResult } from "./execution.js";
import { preview } from "./preview.js";
import { createProgram } from "./program.js";
import type { SourceInput } from "./program.js";

export { ExecutionContext } from "./execution.js";
export type { ExecutionResult } from "./execution.js";
export type { Diagnostic } from "./diagnostics.js";
export type { SourceInput } from "./program.js";

type Preparation = { kind: "checked"; input: CheckedInput } | { kind: "diagnostic"; diagnostics: Diagnostic[] };

export class TypeScriptCompiler {
  prepare(input: SourceInput): Preparation {
    const { program, entry } = createProgram(input);
    const diagnostics = diagnosticsFor(program);
    if (diagnostics.length) return { kind: "diagnostic", diagnostics };

    const { exportName, transform } = preview(entry);
    let code: string | undefined;
    const emitted = program.emit(entry, (_path, text) => { code = text; }, undefined, false, { before: [transform] });
    diagnostics.push(...toDiagnostics("type", emitted.diagnostics));
    if (diagnostics.length) return { kind: "diagnostic", diagnostics };
    if (emitted.emitSkipped || code === undefined) throw new Error(`TypeScript did not emit ${entry.fileName}`);
    return { kind: "checked", input: { fileName: entry.fileName, code, previewExport: exportName } };
  }

  async execute(input: SourceInput, context: ExecutionContext): Promise<ExecutionResult> {
    try {
      const result = this.prepare(input);
      return result.kind === "checked" ? await context.evaluate(result.input) : result;
    } catch (error) {
      return { kind: "execution-error", error };
    }
  }
}
