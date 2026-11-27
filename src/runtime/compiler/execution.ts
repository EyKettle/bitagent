import { constants, createContext, SyntheticModule } from "node:vm";
import type { Module } from "node:vm";

import type { Diagnostic } from "./diagnostics.js";
import { ModuleLoader, RejectedImport } from "./module-loader.js";
import type { PrepareImport } from "./module-loader.js";
import { Project } from "./project.js";
import type { BindingPlan, Definition, TypeSource } from "./scope.js";
import type { CompiledModule } from "./workspace.js";

export type ExecutionResult =
  | { kind: "success"; hasValue: false }
  | { kind: "success"; hasValue: true; value: unknown }
  | { kind: "diagnostic"; diagnostics: readonly Diagnostic[] }
  | { kind: "execution-error"; error: unknown };

export type EvaluatedInput = { result: ExecutionResult; definitions?: readonly Definition[] };

export type CheckedInput = CompiledModule & {
  workspace: ReadonlyMap<string, CompiledModule>;
  previewExport?: string;
  scope?: {
    retained: ReadonlyMap<string, Definition>;
    cells?: { specifier: string; value: object };
    bindings: readonly BindingPlan[];
    typeSource: TypeSource;
  };
};

export class ExecutionContext {
  readonly #global = createContext(constants.DONT_CONTEXTIFY, { name: "BitAgent" });
  readonly #loader: ModuleLoader;

  constructor(globals: Readonly<Record<string, unknown>> = {}, readonly project = new Project(process.cwd())) {
    // The Console runs trusted local code, not tenants in a security sandbox.
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!(name in this.#global) && name !== "global") {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        if (descriptor) Object.defineProperty(this.#global, name, descriptor);
      }
    }
    Object.assign(this.#global, { console, global: this.#global }, globals);
    this.#loader = new ModuleLoader(this.#global, project);
  }

  async evaluate(input: CheckedInput, prepareImport: PrepareImport): Promise<EvaluatedInput> {
    try {
      const { scope } = input;
      const retained = new Map<string, Module>();
      for (const [specifier, binding] of scope?.retained ?? []) retained.set(specifier, binding.module);
      const cells = scope?.cells;
      if (cells) {
        retained.set(cells.specifier, new SyntheticModule(["default"], function () {
          this.setExport("default", cells.value);
        }, { context: this.#global }));
      }
      const module = await this.#loader.run(input, retained, prepareImport);
      const result: ExecutionResult = input.previewExport === undefined
        ? { kind: "success", hasValue: false }
        : { kind: "success", hasValue: true, value: Reflect.get(module.namespace, input.previewExport) };
      const definitions = scope?.bindings.map((binding) => ({ ...binding, module, typeSource: scope.typeSource }));
      return { result, definitions };
    } catch (error) {
      return { result: error instanceof RejectedImport
        ? { kind: "diagnostic", diagnostics: error.diagnostics }
        : { kind: "execution-error", error } };
    }
  }
}
