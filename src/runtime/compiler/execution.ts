import { pathToFileURL } from "node:url";
import { constants, createContext, SourceTextModule } from "node:vm";

import type { Diagnostic } from "./diagnostics.js";

export type ExecutionResult =
  | { kind: "success"; hasValue: false }
  | { kind: "success"; hasValue: true; value: unknown }
  | { kind: "diagnostic"; diagnostics: readonly Diagnostic[] }
  | { kind: "execution-error"; error: unknown };

export type CheckedInput = { fileName: string; code: string; previewExport?: string };

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
    Object.assign(this.#global, { global: this.#global }, globals);
  }

  async evaluate(input: CheckedInput): Promise<ExecutionResult> {
    try {
      const url = pathToFileURL(input.fileName);
      const module = new SourceTextModule(input.code, {
        context: this.#global,
        identifier: url.href,
        initializeImportMeta(meta) { meta.url = url.href; },
      });
      module.linkRequests([]);
      module.instantiate();
      await module.evaluate();
      if (input.previewExport === undefined) return { kind: "success", hasValue: false };
      return { kind: "success", hasValue: true, value: Reflect.get(module.namespace, input.previewExport) };
    } catch (error) {
      return { kind: "execution-error", error };
    }
  }
}
