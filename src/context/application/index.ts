import { resolve } from "node:path";

import { ExecutionContext, TypeScriptCompiler } from "../../runtime/compiler/index.js";
import type { ExecutionResult } from "../../runtime/compiler/index.js";

export type ApplicationOptions = { workspace?: string };

export class Application {
  readonly #compiler = new TypeScriptCompiler();
  readonly #context = new ExecutionContext();
  readonly #consoleFile: string;
  #pending: Promise<unknown> = Promise.resolve();

  constructor({ workspace = process.cwd() }: ApplicationOptions = {}) {
    this.#consoleFile = resolve(workspace, ".bitagent-console.ts");
  }

  submit(source: string): Promise<ExecutionResult> {
    const input = { fileName: this.#consoleFile, source };
    return this.#schedule(() => this.#compiler.execute(input, this.#context));
  }

  #schedule<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.#pending.then(action);
    this.#pending = result.catch(() => {});
    return result;
  }
}
