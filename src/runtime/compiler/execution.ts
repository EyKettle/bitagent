import { pathToFileURL } from "node:url";
import { constants, createContext, SourceTextModule, SyntheticModule } from "node:vm";

import type { Diagnostic } from "./diagnostics.js";
import type { BindingPlan, Definition, TypeSource } from "./scope.js";

export type ExecutionResult =
  | { kind: "success"; hasValue: false }
  | { kind: "success"; hasValue: true; value: unknown }
  | { kind: "diagnostic"; diagnostics: readonly Diagnostic[] }
  | { kind: "execution-error"; error: unknown };

export type EvaluatedInput = { result: ExecutionResult; definitions?: readonly Definition[] };

export type CheckedInput = {
  fileName: string;
  code: string;
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

  constructor(globals: Readonly<Record<string, unknown>> = {}) {
    // The Console runs trusted local code, not tenants in a security sandbox.
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (!(name in this.#global) && name !== "global") {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        if (descriptor) Object.defineProperty(this.#global, name, descriptor);
      }
    }
    Object.assign(this.#global, { console, global: this.#global }, globals);
  }

  async evaluate(input: CheckedInput): Promise<EvaluatedInput> {
    try {
      const url = pathToFileURL(input.fileName);
      const module = new SourceTextModule(input.code, {
        context: this.#global,
        identifier: url.href,
        initializeImportMeta(meta) { meta.url = url.href; },
      });
      const modules = new Map([...input.scope?.retained ?? []].map(([specifier, binding]) => [specifier, binding.module]));
      const cells = input.scope?.cells;
      if (cells) {
        modules.set(cells.specifier, new SyntheticModule(["default"], function () {
          this.setExport("default", cells.value);
        }, { context: this.#global }));
      }
      module.linkRequests(module.moduleRequests.map(({ specifier }) => {
        const dependency = modules.get(specifier);
        if (!dependency) throw new Error(`Cannot load ${specifier} from ${input.fileName}`);
        return dependency;
      }));
      module.instantiate();
      await module.evaluate();
      const result: ExecutionResult = input.previewExport === undefined
        ? { kind: "success", hasValue: false }
        : { kind: "success", hasValue: true, value: Reflect.get(module.namespace, input.previewExport) };
      const { scope } = input;
      const definitions = scope?.bindings.map((binding) => ({ ...binding, module, typeSource: scope.typeSource }));
      return { result, definitions };
    } catch (error) {
      return { result: { kind: "execution-error", error } };
    }
  }
}
