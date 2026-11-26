import type { FixedGlobalNominal } from "./global-nominals.js";
import { contract as originalContract } from "../runtime/contracts.js";
import { defineFunction as originalFunction } from "../runtime/functions.js";
import { tool as originalTool } from "../runtime/tools.js";
import { compilationPhase } from "./measurements.js";
import type { CompilationPhase } from "./measurements.js";
import { freezeRecord } from "../runtime/records.js";
import { Worker } from "node:worker_threads";
import { adoptFileURL, adoptSource } from "./inputs.js";
import { versionRegistry } from "./versions.js";
import { fixedDeclarations } from "./declarations.js";
import { fileURLToPath } from "node:url";
import { Job, currentJob } from "../runtime/jobs.js";
import { fromAsync } from "../runtime/host.js";
import { waitForJob } from "../runtime/jobs.js";
import type { SourceOrigin } from "../compiler/artifacts.js";
import { artifacts, bindings, compilers, definitionTypes, identity, specifications } from "../compiler/artifacts.js";
import { CompilationError } from "../compiler/errors.js";
import { requireSnapshot } from "../state/state.js";
import type { Compiler, CompilationResult, CompilerState, CompiledInput, SourceInput, ModuleVersion } from "../compiler/types.js";
import type { DefinitionSpec, DefinitionType, LiveBinding, StateSnapshot } from "../state/types.js";
import type { CompileRequest, CompileResponse, CachedModule, CachedDeclaration } from "./transport.js";
import { ModuleScope } from "./execution.js";

type CachedGlobalNominal = FixedGlobalNominal & {readonly files:Readonly<Record<string,string>>;readonly sourceOrigins:Readonly<Record<string,SourceOrigin>>};
function moduleVersions(response: CompileResponse, version: (text: string) => string): Map<string, string> {
  const modules = new Map(response.modules.map((module) => [module.url, module]));
  const versions = new Map<string, string>();
  // The reachable component contents, sorted by canonical URL, determine cycles without iterative child hashes.
  for (const module of response.modules) {
    const reachable = new Set<string>();
    const visit = (url: string) => { if (reachable.has(url)) return; reachable.add(url); for (const dependency of Object.values(modules.get(url)?.dependencies ?? {})) if (modules.has(dependency)) visit(dependency); };
    visit(module.url);
    const used=[...new Set([...reachable].flatMap(url=>modules.get(url)!.externalIDs))].sort();
    versions.set(module.url,version(JSON.stringify([module.url,module.fingerprint,used])));
  }
  return versions;
}
export interface TypeScriptCompilerOptions { readonly baseURL: URL; }
export function createTypeScriptCompiler(options: TypeScriptCompilerOptions): Compiler {
  if (!options || typeof options !== "object" || Object.keys(options).some((key) => key !== "baseURL")) throw new TypeError("Invalid compiler options");
  const base = adoptFileURL(options.baseURL, true).href;
  const version = versionRegistry();
  let state: CompilerState = "open", closing: Promise<void> | undefined, worker: Worker | undefined, sequence = 0;
  let pending: { id: number; worker:Worker;signal:AbortSignal; resolve(value: CompileResponse): void; reject(error: unknown): void } | undefined;
  let queue = Promise.resolve();
  const jobs = new Set<Job<CompilationResult>>(), physical=new Set<Worker>();
  const scopes = new WeakMap<object, ModuleScope>();
  const nominalCaches=new WeakMap<object,Map<string,CachedGlobalNominal>>();
  const declarationCaches=new WeakMap<object,Map<string,CachedDeclaration>>();
  const caches = new WeakMap<object,Map<string,CachedModule>>(), libraryFiles:Record<string,string>={};
  const definitionsByName = (snapshot: StateSnapshot) => snapshot.definitions.map((d) => {const value=d.spec.kind==="type"?undefined:snapshot.state.value(d);const generator=value===originalContract?"contract" as const:value===originalFunction?"defineFunction" as const:value===originalTool?"tool" as const:undefined;return {name:d.spec.name,id:d.id,mutable:d.spec.mutable,...(generator?{generator}:{})};});
  function run(request: CompileRequest, signal: AbortSignal): Promise<CompileResponse> {
    const previous = queue; let release!: () => void; queue = new Promise<void>((resolve) => { release = resolve; });
    return (async () => {
      await previous;
      try {
        signal.throwIfAborted();
        if(!worker){
          const instance=new Worker(new URL("./compile-worker.js",import.meta.url),{trackUnmanagedFds:true});worker=instance;physical.add(instance);
          let failed=false,failure:unknown;
          instance.on("message",(message:{phase?:CompilationPhase["phase"];id?:number;workerTime?:number;result?:CompileResponse;error?:{message:string;name:string;stack?:string;properties?:Record<string,unknown>}})=>{
            const active=pending;if(active?.worker!==instance)return;
            if(message.phase){if(message.id===active.id)compilationPhase({phase:message.phase,id:message.id!,workerTime:message.workerTime!});return;}
            pending=undefined;if(message.result)active.resolve(message.result);else{const error=new Error(message.error?.message??"Compiler worker failed");error.name=message.error?.name??"Error";if(message.error?.stack)error.stack=message.error.stack;Object.assign(error,message.error?.properties);active.reject(error);}
          });
          instance.on("error",(error)=>{failed=true;failure=error;if(worker===instance)worker=undefined;});
          instance.on("exit",code=>{physical.delete(instance);if(worker===instance)worker=undefined;const active=pending;if(active?.worker!==instance)return;pending=undefined;active.reject(failed?failure:active.signal.aborted?active.signal.reason:new Error(`Compiler worker exited before completion (${code})`));});
        }
        const instance=worker!;
        const interrupt=()=>{void instance.terminate().catch(error=>{const active=pending;if(active?.worker===instance&& !physical.has(instance)){pending=undefined;active.reject(error);}});};
        signal.addEventListener("abort",interrupt,{once:true});
        let result:CompileResponse;
        try{result=await new Promise<CompileResponse>((resolve,reject)=>{pending={id:request.id,worker:instance,signal,resolve,reject};instance.postMessage(request);});}
        finally{signal.removeEventListener("abort",interrupt);if(pending?.id===request.id)pending=undefined;}
        for(const [file,text]of Object.entries(result.libraryFiles))if(libraryFiles[file]===undefined)libraryFiles[file]=text;
        signal.throwIfAborted(); return result;
      } finally { release(); }
    })();
  }
  const compiler: Compiler = Object.freeze({
    get state() { return state; }, baseURL: base,
    compile(input: SourceInput, snapshot: StateSnapshot): Job<CompilationResult> {
      if (state !== "open") throw new CompilationError("closed", "Compiler is closing or closed");
      requireSnapshot(snapshot); const adopted = adoptSource(input);
      const cache=caches.get(snapshot.state)??new Map<string,CachedModule>();caches.set(snapshot.state,cache);
      const cachedModules=[...cache.values()],declarationCache=declarationCaches.get(snapshot.state)??new Map<string,CachedDeclaration>();declarationCaches.set(snapshot.state,declarationCache);const cachedDeclarations=[...declarationCache.values()];
      const nominalCache=nominalCaches.get(snapshot.state)??new Map<string,CachedGlobalNominal>();nominalCaches.set(snapshot.state,nominalCache);const globalNominals=[...nominalCache.values()];
      const declarationFiles: Record<string,string> = {...libraryFiles}, declarationOrigins:Record<string,SourceOrigin>={}, activeDeclarations=new Set<string>(),ambientDeclarations:Record<string,string>={},ambientOrigins:Record<string,SourceOrigin>={}, imports: string[] = [];
      for(const item of [...cachedModules,...cachedDeclarations,...globalNominals]){Object.assign(declarationFiles,item.files);Object.assign(declarationOrigins,item.sourceOrigins);}
      for (const definition of snapshot.definitions) {
        const record=definitionTypes.get(definition.spec.type);if(!record)throw new CompilationError("invariant","Missing fixed type declaration");
        Object.assign(declarationFiles,record.files);Object.assign(declarationOrigins,record.sourceOrigins);activeDeclarations.add(record.file);Object.assign(ambientDeclarations,record.ambientDeclarations);Object.assign(ambientOrigins,record.ambientOrigins);Object.assign(declarationFiles,record.ambientDeclarations);Object.assign(declarationOrigins,record.ambientOrigins);
        // A fixed re-export keeps aliases tied to their original declaration and implementation generation.
        const source=JSON.stringify(record.file.replace(/\.d\.ts$/, ".js"));
        imports.push(definition.spec.kind === "value" ? `declare ${definition.spec.mutable ? "let" : "const"} ${definition.spec.name}: typeof import(${source}).${record.name};` : `import ${definition.spec.kind === "type" ? "type " : ""}{ ${record.name} as ${definition.spec.name} } from ${source};`);
      }
      const request: CompileRequest = { id:++sequence, entry:adopted.url.href, ...(adopted.kind === "text" ? {text:adopted.text} : {}),statePrelude:imports.join("\n")+(imports.length?"\n":""),declarationFiles,declarationOrigins,globalNominals,activeDeclarations:[...activeDeclarations],ambientDeclarations,ambientOrigins,externalDefinitions:definitionsByName(snapshot),base,cachedModules,cachedDeclarations,libraryFiles:{...libraryFiles} };
      let job!: Job<CompilationResult>;
      job = Job.spawn(function* () {
        const response=yield* fromAsync((signal)=>run(request,signal));
        if(response.diagnostics.some(d=>d.severity==="error"))return Object.freeze({kind:"diagnostics" as const,diagnostics:freezeRecord(response.diagnostics)});
        const versions=moduleVersions(response,version);
        const fixed=fixedDeclarations(response,request.declarationFiles,request.declarationOrigins,versions,snapshot.state.id,request.id,cachedModules,cachedDeclarations,version);
        const declarationFile=fixed.file;
        for(const nominal of response.globalNominals)if(!nominalCache.has(nominal.fingerprint))nominalCache.set(nominal.fingerprint,{...nominal,file:fixed.globalFile,files:fixed.files,sourceOrigins:fixed.sourceOrigins});
        for(const [source,fingerprint]of Object.entries(response.declarationFingerprints)){const file=fixed.paths.get(source);if(file)declarationCache.set(JSON.stringify([source,fingerprint]),{source,fingerprint,file,files:fixed.files,sourceOrigins:fixed.sourceOrigins});}
        for(const module of response.modules)if(module.url!==response.entry){const file=fixed.paths.get(fileURLToPath(module.url));if(file)cache.set(JSON.stringify([module.url,module.fingerprint]),{module,file,files:fixed.files,sourceOrigins:fixed.sourceOrigins});}
        const specs=response.definitions.map(description=>{const type=Object.freeze({id:identity("type"),display:description.display}) as DefinitionType;definitionTypes.set(type,{file:declarationFile,declaration:fixed.declaration,name:description.name,files:fixed.files,sourceOrigins:fixed.sourceOrigins,ambientDeclarations:fixed.ambientDeclarations,ambientOrigins:fixed.ambientOrigins});const {display: _display,...details}=description;const spec=freezeRecord({...details,type,origins:description.origins}) as DefinitionSpec;specifications.add(spec);return spec;});
        const sources=freezeRecord(Object.freeze(response.sources.map(source=>({...source,version:version(JSON.stringify([source.url,source.text]))}))));
        const records:ModuleVersion[]=response.modules.map(module=>{const source=sources.find(source=>source.url===module.url);if(!source)throw new CompilationError("invariant","Module has no adopted source record");return Object.freeze({id:versions.get(module.url)!,url:module.url,sourceVersion:source.version,dependencies:Object.freeze(Object.values(module.dependencies).filter(url=>versions.has(url)).map(url=>versions.get(url)!))});});
        const handle=Object.freeze({id:identity("compilation"),compiler,snapshot,entry:response.entry,sources,modules:Object.freeze(records),definitions:Object.freeze(specs),diagnostics:freezeRecord(response.diagnostics)}) as CompiledInput;
        artifacts.set(handle,{compiler,snapshot,specs,declaration:fixed.declaration,declarationFile,execute(environment,publish){let scope=scopes.get(snapshot.state);if(!scope){scope=new ModuleScope();scopes.set(snapshot.state,scope);}return scope.execute(response.entry,response.modules,versions,environment,publish);}});
        return Object.freeze({kind:"compiled" as const,input:handle});
      });
      jobs.add(job);void waitForJob(job).then(()=>jobs.delete(job));return job;
    },
    close(reason?: unknown): Promise<void> {
      if(jobs.has(currentJob() as Job<CompilationResult>))throw new CompilationError("busy","Cannot close Compiler from its own work");if(closing)return closing;state="closing";
      closing=(async()=>{const active=[...jobs];for(const job of active)job.cancel(reason);const outcomes=await Promise.all(active.map(waitForJob));await queue;await Promise.all([...physical].map(instance=>instance.terminate()));worker=undefined;state="closed";const failures=outcomes.filter(o=>o.state==="failed").map(o=>o.error);if(failures.length===1)throw failures[0];if(failures.length>1)throw new AggregateError(failures,"Compiler shutdown failed");})().finally(()=>{state="closed";});return closing;
    },
  }) as Compiler;
  compilers.set(compiler,{adopt:adoptSource});return compiler;
}
