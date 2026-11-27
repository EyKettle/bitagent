import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { bindingExports, bindingSetters, planBindings } from "./bindings.js";
import { diagnosticsFor, toDiagnostics } from "./diagnostics.js";
import type { Diagnostic } from "./diagnostics.js";
import type { CheckedInput, EvaluatedInput, ExecutionContext, ExecutionResult } from "./execution.js";
import { preview } from "./preview.js";
import { Compilation, resolveComputedModule } from "./program.js";
import { Project } from "./project.js";
import { bindScope, mutableBindingTransforms } from "./scope-input.js";
import type { BatchScope, SourceInput } from "./scope.js";
import { emitModule } from "./workspace.js";
import type { CompiledModule } from "./workspace.js";

export { ExecutionContext } from "./execution.js";
export { Project } from "./project.js";
export type { ExecutionResult } from "./execution.js";
export type { Diagnostic } from "./diagnostics.js";
export type { BatchScope, Definition, SourceInput } from "./scope.js";

type Preparation = { kind: "checked"; input: CheckedInput } | { kind: "diagnostic"; diagnostics: Diagnostic[] };

export class TypeScriptCompiler {
  #prepare(input: SourceInput, project: Project, definitions: BatchScope | undefined, previewResult: boolean): Preparation {
    const scope = definitions && bindScope(input, definitions.bindings);
    const adopted = scope?.input ?? input;
    const fileName = resolve(input.fileName);
    const reject = (diagnostics: Diagnostic[]): Preparation => ({
      kind: "diagnostic",
      diagnostics: diagnostics.map((diagnostic) => scope && diagnostic.fileName === adopted.fileName
        ? { ...diagnostic, fileName }
        : diagnostic),
    });
    const compilation = new Compilation(project);
    const initial = compilation.program(adopted, scope?.imports);
    const diagnostics = diagnosticsFor(initial.program);
    if (diagnostics.length) return reject(diagnostics);

    const bindings = scope ? planBindings(initial.program, initial.entry, scope.sourceEnd, scope.prefix) : [];
    const source = bindings.length ? `${adopted.source}\n${bindingExports(bindings)}` : adopted.source;
    const { program, entry, workspaces, resolutions } = bindings.length
      ? compilation.program({ ...adopted, source }, scope?.imports)
      : initial;
    if (bindings.length) {
      diagnostics.push(...diagnosticsFor(program));
      if (diagnostics.length) return reject(diagnostics);
    }

    const resultPreview = previewResult ? preview(entry, input.source.length) : undefined;
    const transforms = scope?.mutable.size ? mutableBindingTransforms(program, entry, scope) : {};
    if (resultPreview) (transforms.before ??= []).push(resultPreview.transform);
    const emitted = emitModule(program, entry, resolutions(entry.fileName), transforms);
    diagnostics.push(...toDiagnostics("type", emitted.diagnostics));
    if (diagnostics.length) return reject(diagnostics);
    if (!emitted.module) throw new Error(`TypeScript did not emit ${entry.fileName}`);

    const workspace = new Map<string, CompiledModule>();
    for (const path of workspaces) {
      const file = program.getSourceFile(path);
      if (!file) continue;
      const cached = project.module(path);
      if (cached) {
        workspace.set(path, cached);
        continue;
      }
      const output = emitModule(program, file, resolutions(path));
      diagnostics.push(...toDiagnostics("type", output.diagnostics));
      if (output.module) workspace.set(path, output.module);
      else if (!diagnostics.length) throw new Error(`TypeScript did not emit ${path}`);
    }
    if (diagnostics.length) return reject(diagnostics);

    const checked: CheckedInput = { ...emitted.module, fileName, workspace, previewExport: resultPreview?.exportName };
    if (scope && definitions) {
      const specifier = `bitagent:${scope.prefix}`;
      const cellsSpecifier = `${specifier}cells`;
      checked.scope = {
        retained: scope.retained,
        cells: scope.mutable.size ? { specifier: cellsSpecifier, value: definitions.retainCells(scope.mutable.keys()) } : undefined,
        bindings,
        typeSource: { source, specifier, imports: scope.imports, fileName: entry.fileName },
      };
      if (scope.mutable.size) checked.code += `\nimport ${scope.prefix}cells from ${JSON.stringify(cellsSpecifier)};`;
      checked.code += `\n${bindingSetters(bindings)}`;
    }
    return { kind: "checked", input: checked };
  }

  #prepareImport(specifier: string, from: string, project: Project): Preparation | undefined {
    const path = resolveComputedModule(specifier, from, project);
    if (!path) return undefined;
    return this.#prepare({ fileName: path, source: project.module(path)?.source ?? readFileSync(path, "utf8") }, project, undefined, false);
  }

  async execute(input: SourceInput, context: ExecutionContext): Promise<ExecutionResult> {
    return (await this.executeBatch(input, context)).result;
  }

  async executeBatch(input: SourceInput, context: ExecutionContext, scope?: BatchScope): Promise<EvaluatedInput> {
    try {
      const { project } = context;
      const prepared = this.#prepare(input, project, scope, true);
      return prepared.kind === "checked"
        ? await context.evaluate(prepared.input, (specifier, from) => this.#prepareImport(specifier, from, project))
        : { result: prepared };
    } catch (error) {
      return { result: { kind: "execution-error", error } };
    }
  }
}
