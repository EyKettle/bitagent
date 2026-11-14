import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createContext } from "node:vm";
import tsNode from "ts-node";
import type { Application, TextGenerator } from "../index.js";
import { configureReplCompiler } from "./compiler.js";

export interface ScriptConsoleOptions {
  readonly app: Application;
  readonly llm: TextGenerator;
  /** Base directory for the virtual script and its ordinary package imports. */
  readonly cwd?: string;
}

export interface Evaluation {
  /** Unknown at the host boundary; a returned Promise is not implicitly awaited. */
  readonly value: unknown;
}

export interface ScriptConsole {
  /** Complete snippets are serialized; long work belongs in app.start(). */
  evaluate(source: string): Promise<Evaluation>;
  /** Drops console bindings and types, not application runs or their captured values. */
  reset(): Promise<void>;
}

export class ScriptCompileError extends Error {
  constructor(readonly diagnostics: string) {
    super(diagnostics.trim());
    this.name = "ScriptCompileError";
  }
}

/** Trusted user code with host privileges, NOT a security sandbox or durable runtime. */
export async function createScriptConsole(options: ScriptConsoleOptions): Promise<ScriptConsole> {
  const { app, llm } = options;
  const cwd = resolve(options.cwd ?? process.cwd());
  const publicEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const hostRequire = createRequire(import.meta.url);
  const nodeTypesRoot = dirname(dirname(hostRequire.resolve("@types/node/package.json")));
  const declarations = [
    "export {};",
    "declare const app: import(" + JSON.stringify(publicEntry) + ").Application;",
    "declare const llm: import(" + JSON.stringify(publicEntry) + ").TextGenerator;",
  ].join("\n");

  async function createKernel() {
    let diagnostics = "";
    const stderr = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        diagnostics += chunk.toString();
        callback();
      },
    });
    // EvalState is exposed by createRepl().state, not as a root runtime constructor.
    const state = tsNode.createRepl().state;
    state.path = join(cwd, "[bitagent].cts");
    const repl = tsNode.createRepl({ state, stderr });
    const service = tsNode.create({
      ...repl.evalAwarePartialHost,
      cwd,
      skipProject: true,
      transpileOnly: false,
      typeCheck: true,
      experimentalReplAwait: true,
      compilerOptions: {
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        esModuleInterop: true,
        types: ["node"],
        typeRoots: [nodeTypesRoot],
        skipLibCheck: true,
      },
    });
    configureReplCompiler(service, state.path);
    repl.setService(service);
    const module = { exports: {} };
    const context = createContext({
      console, process, Buffer,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
      queueMicrotask, structuredClone, performance,
      AbortController, AbortSignal, DOMException,
      URL, URLSearchParams, TextEncoder, TextDecoder,
      fetch, Headers, Request, Response, FormData, Blob,
      module, exports: module.exports,
      require: createRequire(join(cwd, "[bitagent].cjs")),
      __dirname: cwd,
      __filename: state.path,
    });
    context.global = context;
    Object.defineProperties(context, {
      app: { value: app, enumerable: true },
      llm: { value: llm, enumerable: true },
    });

    function evaluate(source: string): Promise<Evaluation> {
      diagnostics = "";
      return new Promise((resolveResult, reject) => {
        repl.nodeEval(source + "\n", context, state.path, (...args: [Error | null, unknown?]) => {
          const [error, value] = args;
          if (diagnostics !== "") reject(new ScriptCompileError(diagnostics));
          // ts-node reports a thrown value with one argument, even for throw null.
          else if (error !== null || args.length < 2) reject(error);
          else resolveResult(Object.freeze({ value }));
        });
      });
    }
    await evaluate(declarations);
    return { evaluate };
  }

  let kernel = await createKernel();
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({
    evaluate: (source: string) => enqueue(() => kernel.evaluate(source)),
    reset: () => enqueue(async () => { kernel = await createKernel(); }),
  });
}
