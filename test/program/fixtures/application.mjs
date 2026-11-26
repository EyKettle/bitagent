import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createExecutionRoot,createCompilerSession,waitForJob} from '@bitagent/core/host';
import {createState} from '@bitagent/core/state';
import {createTypeScriptCompiler} from '@bitagent/core/node';
export async function application(t) {
 const directory=await mkdtemp(path.join(os.tmpdir(),'bitagent-program-'));
 const baseURL=pathToFileURL(directory+path.sep),root=createExecutionRoot(),state=createState(),compiler=createTypeScriptCompiler({baseURL}),session=createCompilerSession({root,state,compiler});
 t?.after(async()=>{const results=await Promise.allSettled([session.close(),root.close()]);const closed=await Promise.allSettled([compiler.close(),rm(directory,{recursive:true,force:true})]);const errors=[...results,...closed].filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Application fixture cleanup');});
 const input=(text,name='input.ts')=>({kind:'text',url:new URL(name,baseURL),text});
 const prepare=async(text,name)=>{const outcome=await waitForJob(root.run(()=>session.prepare(input(text,name))));assert.equal(outcome.state,'finished',String(outcome.error));return outcome.value;};
 const execute=async(text,name)=>{const result=await prepare(text,name);assert.equal(result.kind,'ready',JSON.stringify(result));return session.execute(result.input);};
 return {directory,baseURL,root,state,compiler,session,input,prepare,execute,write:async(name,text)=>writeFile(new URL(name,baseURL),text),value:(name)=>state.value(state.find(name))};
}
