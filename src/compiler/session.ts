import { Job, waitForJob, currentJob } from "../runtime/jobs.js";
import { isExecutionRoot } from "../runtime/types.js";
import type { ExecutionRoot } from "../runtime/types.js";
import { artifact, associations, bindings, compilers } from "./artifacts.js";
import { CompilationError } from "./errors.js";
import { beginPublication, captureBindings, requireState } from "../state/state.js";
import type { ApplicationState, LiveBinding } from "../state/types.js";
import type { Compiler, CompilerSession, CompilerState, InputExecution, PreparedInput, PreparedInputState, PreparationResult, SourceInput } from "./types.js";
export interface CompilerSessionOptions { readonly state: ApplicationState; readonly root: ExecutionRoot; readonly compiler: Compiler; }
interface Prepared { readonly owner: CompilerSession; state: PreparedInputState; }
const prepared = new WeakMap<PreparedInput, Prepared>();
export function createCompilerSession(options: CompilerSessionOptions): CompilerSession {
  if(!options||typeof options!=="object"||Object.keys(options).some(k=>!["state","root","compiler"].includes(k)))throw new TypeError("Invalid Session options");
  const {state:applicationState,root,compiler}=options;requireState(applicationState);
  if(!compilers.has(compiler)||!isExecutionRoot(root))throw new TypeError("Expected authentic root and compiler");
  if(root.state!=="open"||compiler.state!=="open")throw new CompilationError("closed","Session requires open services");
  const existing=associations.get(applicationState);if(existing&&(existing.root!==root||existing.compiler!==compiler))throw new CompilationError("configuration","State is associated with different services");
  associations.set(applicationState,{root,compiler});
  let state:CompilerState="open",closing:Promise<void>|undefined,executing=false;
  const jobs=new Set<Job<PreparationResult>>(),unused=new Set<PreparedInput>();
  function admission():void{if(state!=="open"||root.state!=="open")throw new CompilationError("closed","Session or root is closed");}
  const session:CompilerSession=Object.freeze({
    get state(){return state;},applicationState,compiler,
    prepare(input:SourceInput):Job<PreparationResult>{admission();if(compiler.state!=="open")throw new CompilationError("closed","Compiler is closed");
      // The actual adapter validates and adopts before the preparing Job exists.
      const adopted = compilers.get(compiler)!.adopt(input);
      const snapshot=applicationState.snapshot();
      const job=Job.spawn(function*(){const compilation=compiler.compile(adopted,snapshot);const result=yield* compilation.wait();if(result.kind==="diagnostics")return result;const record:Prepared={owner:session,state:"ready"};const handle=Object.freeze({get state(){return record.state;},compilation:result.input}) as PreparedInput;prepared.set(handle,record);unused.add(handle);return Object.freeze({kind:"ready" as const,input:handle});});
      jobs.add(job);void waitForJob(job).then(()=>jobs.delete(job));return job;
    },
    execute(input:PreparedInput):InputExecution{admission();const record=prepared.get(input);if(!record)throw new TypeError("Expected authentic prepared input");if(record.owner!==session)throw new CompilationError("foreign","Input belongs to another Session");if(record.state!=="ready")throw new CompilationError("used","Input has already been consumed");if(executing)throw new CompilationError("busy","Session is executing");
      const compiled=artifact(input.compilation);if(compiled.snapshot.revision!==applicationState.revision)throw new CompilationError("stale","State structure changed");
      return root.run(()=>{const publication=beginPublication(applicationState,input.compilation);record.state="used";unused.delete(input);executing=true;let value:unknown,threw=false,error:unknown;
        const captured=captureBindings(applicationState), references=new Map<string,{value:unknown}>();
        const environment={binding(id:string):{value:unknown}{
          let reference=references.get(id);if(reference)return reference;
          const binding=captured.get(id);if(!binding)throw new CompilationError("stale","Missing captured binding");
          reference=Object.defineProperty({},"value",{get:()=>binding.read(),set:(value:unknown)=>{if(!binding.write)throw new TypeError("Binding is not mutable");binding.write(value);}}) as {value:unknown};
          references.set(id,reference);return reference;
        }};
        let discovered:Readonly<Record<string,{read():unknown;write?(value:unknown):void}>>={},captureAccepted=false;
        const published=new Set<string>(),valueSpecifications=new Map(compiled.specs.filter(spec=>spec.kind!=="type").map(spec=>[spec.name,spec]));
        const publishKnown=(names?:readonly string[])=>{const candidates=names?names.map(name=>valueSpecifications.get(name)):valueSpecifications.values();for(const spec of candidates){if(!spec||published.has(spec.name))continue;const accessor=discovered[spec.name];if(!accessor)continue;try{accessor.read();}catch(caught){if(caught instanceof ReferenceError)continue;throw caught;}const binding=Object.freeze({spec,read:accessor.read,...(spec.mutable&&accessor.write?{write:accessor.write}:{})}) as LiveBinding;bindings.set(binding,{input:input.compilation});publication.publish(binding);published.add(spec.name);}};
        let change:InputExecution["change"];
        try{value=compiled.execute(environment,(capture)=>{if(!captureAccepted&&capture.values){discovered=capture.values;captureAccepted=true;}publishKnown(capture.initialized);});}catch(caught){threw=true;error=caught;}finally{try{publishKnown();}finally{change=publication.finish();executing=false;}}
        return Object.freeze(threw?{kind:"threw" as const,error,change}:{kind:"returned" as const,value,change});
      });
    },
    discard(input:PreparedInput):boolean{const record=prepared.get(input);if(!record)throw new TypeError("Expected authentic prepared input");if(record.owner!==session)throw new CompilationError("foreign","Foreign prepared input");if(record.state!=="ready")return false;record.state="discarded";unused.delete(input);return true;},
    close(reason?:unknown):Promise<void>{if(executing||jobs.has(currentJob() as Job<PreparationResult>))throw new CompilationError("busy","Cannot close a Session from its own active operation");if(closing)return closing;state="closing";closing=(async()=>{const active=[...jobs];for(const job of active)job.cancel(reason);const outcomes=await Promise.all(active.map(waitForJob));for(const input of unused)session.discard(input);state="closed";const errors=outcomes.filter(o=>o.state==="failed").map(o=>o.error);if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,"Session shutdown failed");})().finally(()=>{state="closed";});return closing;},
  }) as CompilerSession;return session;
}
