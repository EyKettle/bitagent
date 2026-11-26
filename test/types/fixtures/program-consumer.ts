import {Job,contract,defineFunction,tool,type JobFunction,type Contract,type Coroutine} from '@bitagent/core';
import {createExecutionRoot,createCompilerSession,beginPublication,waitForJob} from '@bitagent/core/host';
import {createState,type StateSnapshot,type Definition} from '@bitagent/core/state';
import {type SourceInput,type CompiledInput,type PreparedInput,type CompilerSession,type Compiler,type InputExecution} from '@bitagent/core/compiler';
import {createTypeScriptCompiler,type TypeScriptCompilerOptions} from '@bitagent/core/node';
const options:TypeScriptCompilerOptions={baseURL:new URL('file:///workspace/')};
const compiler:Compiler=createTypeScriptCompiler(options),root=createExecutionRoot(),state=createState();
const session:CompilerSession=createCompilerSession({compiler,root,state});
const snapshot:StateSnapshot=state.snapshot(),input:SourceInput={kind:'text',url:new URL('input.ts',options.baseURL),text:'const value=1;'};
const job=root.run(()=>session.prepare(input));const outcome=waitForJob(job);
const work:JobFunction<(n:number)=>number>=defineFunction<(n:number)=>number>(function*(_result,n):Coroutine<number>{return n+1;});
const parser:Contract<{n:number}>=contract<{n:number}>();const named=tool<{n:number},number>('named',p=>p.n);
const called=root.run(()=>work(1));const number:number=called.result;
// @ts-expect-error prepared handles cannot be fabricated
const forged:PreparedInput={state:'ready',compilation:{} as CompiledInput};
// @ts-expect-error complete source records have a URL and source discriminator
session.prepare({text:'1'});
// @ts-expect-error private compiled metadata is not replaceable
const fake:CompiledInput={id:'x',compiler,snapshot,entry:'x',sources:[],modules:[],definitions:[],diagnostics:[]};
// @ts-expect-error State values take authentic definition handles, not names
state.value('name');
function compileContext(compiled:CompiledInput,prepared:PreparedInput,definition:Definition){const execution:InputExecution=session.execute(prepared);const publication=beginPublication(state,compiled);publication.finish();state.value(definition);return execution;}
void [Job,number,outcome,parser,named,forged,fake,compileContext];
