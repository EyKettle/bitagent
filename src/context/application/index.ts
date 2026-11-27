import { ExecutionContext, Project, TypeScriptCompiler } from "../../runtime/compiler/index.js";
import type { ExecutionResult, SourceInput } from "../../runtime/compiler/index.js";
import { Definitions } from "../../runtime/operation/index.js";
import { ScriptFiles } from "./script-files.js";
import type { ScriptFile } from "./script-files.js";

export type { ScriptFile } from "./script-files.js";

export type ApplicationOptions = { workspace?: string };

export class Application {
  readonly #compiler = new TypeScriptCompiler();
  readonly #context: ExecutionContext;
  readonly #definitions = new Definitions();
  readonly #project: Project;
  readonly #files: ScriptFiles;
  #pending: Promise<unknown> = Promise.resolve();

  constructor({ workspace = process.cwd() }: ApplicationOptions = {}) {
    this.#project = new Project(workspace);
    this.#context = new ExecutionContext({}, this.#project);
    this.#files = new ScriptFiles(this.#project.directory);
  }

  submit(source: string): Promise<ExecutionResult> {
    return this.#schedule(() => this.#execute({ fileName: this.#project.consoleFile, source }));
  }

  acquireFile(path: string): Promise<ScriptFile> {
    return this.#schedule(() => this.#files.acquire(path));
  }

  runFile(file: ScriptFile): Promise<ExecutionResult> {
    return this.#schedule(async () => {
      try {
        return await this.#execute(this.#files.source(file));
      } catch (error) {
        return { kind: "execution-error", error };
      }
    });
  }

  drop(name: string): Promise<boolean> {
    return this.#schedule(() => this.#definitions.drop(name));
  }

  async #execute(input: SourceInput): Promise<ExecutionResult> {
    const { result, definitions } = await this.#compiler.executeBatch(input, this.#context, this.#definitions);
    if (definitions) this.#definitions.introduce(definitions);
    return result;
  }

  #schedule<T>(action: () => T | Promise<T>): Promise<T> {
    const result = this.#pending.then(action);
    this.#pending = result.catch(() => {});
    return result;
  }
}
