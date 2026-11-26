import { generatedTool, tool as originalTool } from "../runtime/tools.js";
import type { ToolArtifact } from "../runtime/tools.js";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { generatedContract, contract as originalContract } from "../runtime/contracts.js";
import { generatedFunction, defineFunction as originalFunction } from "../runtime/functions.js";
import type { DataShape } from "../runtime/contracts.js";
import type { FunctionArtifact } from "../runtime/functions.js";
import type { EmittedModule } from "./transport.js";
import type { ExecutionBindings } from "../compiler/artifacts.js";
import { retainContext, releaseContext } from "./bridge.js";
export interface Environment { binding(id: string): { value: unknown }; }
interface ModuleRecord { readonly url: string; readonly code: string; readonly dependencies: Readonly<Record<string, string>>; }
const records = new Map<string, ModuleRecord>();
const origins = new Map<string, Pick<ModuleRecord,"url"|"dependencies">>();
const bridge = new URL("./bridge.js", import.meta.url).href;
const packageRoot = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
let hooks: ReturnType<typeof registerHooks> | undefined;
function register(): void {
  if (hooks) return;
  hooks = registerHooks({
    resolve(specifier, context, next) {
      const absolute=path.isAbsolute(specifier)?pathToFileURL(specifier).href:specifier;
      if (records.has(absolute)) return { url: absolute, format: "module", shortCircuit: true };
      const parent = context.parentURL && (records.get(context.parentURL)??origins.get(context.parentURL));
      if (parent) {
        if (/^@bitagent\/core(?:\/(host|state|compiler|node))?$/.test(specifier)) return { url: new URL(`${specifier.split("/")[2] ?? "index"}.js`, packageRoot).href, shortCircuit: true };
        if (specifier === bridge) return next(specifier, context);
        const url = parent.dependencies[specifier];
        if (!url) return next(specifier,{...context,parentURL:parent.url});
        return { url, format: "module", shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) { const record = records.get(url); return record ? { source: record.code, format: "module", shortCircuit: true } : next(url, context); },
  });
}
/** Native synchronous ESM loading preserves hoisting, live exports, cycles and failure caching. */
export class ModuleScope {
  private readonly id = randomUUID();
  private readonly contexts = new Map<string, string>();
  execute(entry: string, modules: readonly EmittedModule[], versions: ReadonlyMap<string, string>, environment: Environment, capture: (bindings: ExecutionBindings) => void): unknown {
    register();
    const urls = new Map(modules.map((module) => [module.url, new URL(`./.__bitagent__/modules/${this.id}/${versions.get(module.url)}.mjs`,import.meta.url).href]));
    const entryURL = new URL(`./.__bitagent__/entries/${randomUUID()}.mjs`,import.meta.url).href; urls.set(entry, entryURL);
    let display:(()=>unknown)|undefined;
    const generated = { guard(name:"contract"|"defineFunction"|"tool",target:unknown,artifact:unknown,receiver?:unknown):unknown{const original={contract:originalContract,defineFunction:originalFunction,tool:originalTool}[name];if(target!==original)return typeof target==="function"&&receiver!==undefined?(...args:unknown[])=>Reflect.apply(target,receiver,args):target;return (...args:unknown[])=>name==="contract"?generatedContract(artifact as DataShape):name==="defineFunction"?generatedFunction(args[0] as Parameters<typeof generatedFunction>[0],args[1] as Parameters<typeof generatedFunction>[1],artifact as FunctionArtifact):generatedTool(args[0] as string,args[1],args[2] as Parameters<typeof generatedTool>[2],artifact as ToolArtifact);}, tool(...args: unknown[]) {const artifact=args.pop() as ToolArtifact;return generatedTool(args[0] as string,args[1],args[2] as Parameters<typeof generatedTool>[2],artifact);}, contract(shape: DataShape) { return generatedContract(shape); }, defineFunction(...args: unknown[]) { const artifact = args.pop() as FunctionArtifact; return generatedFunction(args[0] as Parameters<typeof generatedFunction>[0], args[1] as Parameters<typeof generatedFunction>[1], artifact); } };
    for (const module of modules) {
      const url = urls.get(module.url)!;
      if (records.has(url)) continue;
      const token = randomUUID(); this.contexts.set(url, token);
      retainContext(token, { environment, generated, capture: module.url === entry ? (bindings)=>{if(!display&&bindings.result)display=bindings.result;capture(bindings);} : () => {}, initialize(metadata){const resolve=metadata.resolve.bind(metadata);Object.assign(metadata,{url:module.url,filename:fileURLToPath(module.url),dirname:path.dirname(fileURLToPath(module.url)),resolve(specifier:string){const resolved=resolve(specifier);return origins.get(resolved)?.url??resolved;}});} });
      const dependencies = Object.fromEntries(Object.entries(module.dependencies).map(([name, target]) => [name, urls.get(target) ?? target]));
      origins.set(url,{url:module.url,dependencies});
      records.set(url, { url:module.url,code: `import { acquire as ${module.helpers.acquire} } from ${JSON.stringify(bridge)};\nconst {environment: ${module.helpers.environment}, generated: ${module.helpers.generated}, capture: ${module.helpers.capture}} = ${module.helpers.acquire}(${JSON.stringify(token)}, import.meta);\n${module.code}`, dependencies });
    }
    try { require(fileURLToPath(entryURL)); return display?.(); }
    finally {
      // Native initialized bindings retain their context objects, not the temporary lookup token.
      for (const url of urls.values()) { const token=this.contexts.get(url); if(token){releaseContext(token);this.contexts.delete(url);} records.delete(url); }
    }
  }
}
