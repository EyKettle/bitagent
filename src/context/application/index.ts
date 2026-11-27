import { resolve } from "node:path";

import { ExecutionContext, TypeScriptCompiler } from "../../runtime/compiler/index.js";
import type { ExecutionResult } from "../../runtime/compiler/index.js";
import { Definitions } from "../../runtime/operation/index.js";

export type ApplicationOptions = { workspace?: string };

export class Application {
  readonly #compiler = new TypeScriptCompiler();
  readonly #context = new ExecutionContext();
  readonly #definitions = new Definitions();
  readonly #consoleFile: string;
  #pending: Promise<unknown> = Promise.resolve();

  constructor({ workspace = process.cwd() }: ApplicationOptions = {}) {
    this.#consoleFile = resolve(workspace, ".bitagent-console.ts");
  }

  submit(source: string): Promise<ExecutionResult> {
    const input = { fileName: this.#consoleFile, source };
    return this.#schedule(async () => {
      const { result, definitions } = await this.#compiler.executeBatch(input, this.#context, this.#definitions);
      if (definitions) this.#definitions.introduce(definitions);
      return result;
    });
  }

  drop(name: string): Promise<boolean> {
    return this.#schedule(() => this.#definitions.drop(name));
  }

  #schedule<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.#pending.then(action);
    this.#pending = result.catch(() => {});
    return result;
  }
}
