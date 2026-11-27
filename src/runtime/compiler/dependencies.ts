import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON, isBuiltin } from "node:module";
import { extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SyntheticModule } from "node:vm";
import type { Context, ModuleRequest } from "node:vm";
import { parse } from "cjs-module-lexer";

export type Request = Pick<ModuleRequest, "specifier" | "attributes" | "phase">;
export type DependencySource = { url: string; fileName: string; code: string };

type Dependency = DependencySource | SyntheticModule;

export function requireEvaluation(request: Request, allowAttributes: boolean): void {
  if (request.phase !== "evaluation" || (!allowAttributes && Object.keys(request.attributes).length)) {
    throw new Error(`Unsupported import attributes or phase for ${request.specifier}`);
  }
}

export class DependencyLoader {
  readonly #context: Context;
  readonly #modules = new Map<string, Promise<Dependency>>();

  constructor(context: Context) {
    this.#context = context;
  }

  load(url: string, request: Request, requiresCheckedSource: boolean): Promise<Dependency> {
    requireEvaluation(request, true);
    if (requiresCheckedSource && (!url.startsWith("file:") || extname(fileURLToPath(url)) !== ".json")) {
      throw new Error(`No checked source for ${url}`);
    }
    const attributes = Object.entries(request.attributes).filter((entry): entry is [string, string] => entry[1] !== undefined).sort();
    const key = JSON.stringify([url, attributes]);
    let loaded = this.#modules.get(key);
    if (!loaded) {
      loaded = this.#load(url, request, Object.fromEntries(attributes));
      this.#modules.set(key, loaded);
    }
    return loaded;
  }

  async #load(url: string, request: Request, attributes: Record<string, string>): Promise<Dependency> {
    if (isBuiltin(url)) return this.#valueModule(url, await import(url, { with: attributes }));
    if (!url.startsWith("file:")) throw new Error(`Unsupported dependency URL: ${url}`);
    const fileName = fileURLToPath(url);
    const extension = extname(fileName);
    if (extension === ".json") return this.#valueModule(url, await import(url, { with: attributes }));

    requireEvaluation(request, false);
    if (moduleFormat(fileName) === "module") return { url, fileName, code: readFileSync(fileName, "utf8") };
    const exports = new Set(["default", "module.exports"]);
    commonJSExports(fileName, exports, new Set());
    const require = createRequire(url);
    // Node discovers named CommonJS exports before linking and takes their values at evaluation.
    return new SyntheticModule([...exports], function () {
      const value: unknown = require(fileName);
      const object = value !== null && (typeof value === "object" || typeof value === "function");
      for (const name of exports) {
        this.setExport(name, name === "default" || name === "module.exports"
          ? value
          : object && Object.hasOwn(value, name) ? Reflect.get(value, name) : undefined);
      }
    }, { context: this.#context, identifier: url });
  }

  #valueModule(url: string, namespace: object): SyntheticModule {
    const names = Object.keys(namespace);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, Reflect.get(namespace, name));
    }, { context: this.#context, identifier: url });
  }
}

function moduleFormat(fileName: string): "module" | "commonjs" {
  switch (extname(fileName)) {
    case ".mjs": return "module";
    case ".cjs": return "commonjs";
    case ".js": {
      const manifest = findPackageJSON(pathToFileURL(fileName));
      const config: unknown = manifest && JSON.parse(readFileSync(manifest, "utf8"));
      return config && typeof config === "object" && "type" in config && config.type === "module" ? "module" : "commonjs";
    }
    default: throw new Error(`Unsupported dependency format: ${fileName}`);
  }
}

function commonJSExports(fileName: string, names: Set<string>, visited: Set<string>): void {
  if (visited.has(fileName)) return;
  visited.add(fileName);
  const { exports, reexports } = parse(readFileSync(fileName, "utf8"));
  for (const name of exports) names.add(name);
  const require = createRequire(fileName);
  for (const reexport of reexports) {
    let resolved: string;
    try {
      resolved = require.resolve(reexport);
    } catch {
      // The lexer can identify optional or unreachable require calls; Node evaluates them later.
      continue;
    }
    if (/\.(?:js|cjs)$/u.test(resolved) && moduleFormat(resolved) === "commonjs") commonJSExports(resolved, names, visited);
  }
}
