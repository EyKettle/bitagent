import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { SourceInput } from "../../runtime/compiler/index.js";

export type ScriptFile = Readonly<{ fileName: string }>;

export class ScriptFiles {
  readonly #sources = new WeakMap<ScriptFile, SourceInput>();
  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  async acquire(path: string): Promise<ScriptFile> {
    const fileName = await realpath(resolve(this.#workspace, path));
    if (!/\.(?:ts|mts)$/u.test(fileName) || /\.d\.(?:ts|mts)$/u.test(fileName)) {
      throw new Error(`Expected a .ts or .mts source file: ${fileName}`);
    }
    const handle = await open(fileName, constants.O_RDONLY | constants.O_NONBLOCK);
    let source: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${fileName}`);
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const file = Object.freeze({ fileName });
    this.#sources.set(file, { fileName, source });
    return file;
  }

  source(file: ScriptFile): SourceInput {
    const input = this.#sources.get(file);
    if (!input) throw new Error("This application did not acquire the script file");
    return input;
  }
}
