import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import * as Core from "@bitagent/core";
import * as Host from "@bitagent/core/host";
import * as State from "@bitagent/core/state";
import * as Compiler from "@bitagent/core/compiler";
import * as Node from "@bitagent/core/node";

const directory=await mkdtemp(path.join(os.tmpdir(),"bitagent-installed-program-"));
const baseURL=pathToFileURL(directory+path.sep),root=Host.createExecutionRoot(),state=State.createState(),compiler=Node.createTypeScriptCompiler({baseURL}),session=Host.createCompilerSession({root,state,compiler}),checks=[];
async function prepare(text,name="input.ts") {const outcome=await Host.waitForJob(root.run(()=>session.prepare({kind:"text",url:new URL(name,baseURL),text})));assert.equal(outcome.state,"finished");assert.equal(outcome.value.kind,"ready",JSON.stringify(outcome));return outcome.value.input;}
async function execute(text,name) {const input=await prepare(text,name);const result=session.execute(input);assert.equal(result.kind,"returned",String(result.error));return result;}
const value=name=>state.value(state.find(name));
try {
 await writeFile(new URL("dependency.ts",baseURL),"export const object={version:1}; export const token=Symbol();");
 await execute("import {contract,defineFunction,Job,tool} from '@bitagent/core'; import {fromAsync} from '@bitagent/core/host'; import {object,token} from './dependency.js'; interface Box {amount:number}; const parser=contract<Box>(); let entered=0; const work=defineFunction<(input:Box)=>number>(function*(_result,input){entered++; return input.amount+1;},{start:'manual'}); const named=tool<Box,number>('increment',p=>p.amount+1); let ioDone=false,cleaned=0; const slow=defineFunction<(n:number)=>number>(function*(_result,n){try{yield* fromAsync(()=>new Promise(resolve=>setTimeout(()=>{ioDone=true;resolve(null)},15)));return n;}finally{cleaned++;}}); const publicJob=Job;");
 assert.equal(value("publicJob"),Core.Job);checks.push("actual Core singleton");
 const original=value("object");await execute("import {object as alias,token as sameToken} from './dependency.js'; const checked:typeof token=sameToken;","second.ts");assert.equal(value("alias"),original);assert.equal(value("checked"),value("token"));assert.equal(state.aliases(original).length,2);checks.push("original bindings and adopted nominal types");
 const source={amount:1},copy=value("parser").parse(source);assert.deepEqual(copy,source);assert.notEqual(copy,source);assert.throws(()=>value("parser").parse({amount:"wrong"}),Core.ContractError);checks.push("generated value contract and independent adoption");
 const job=root.run(()=>value("work")(source));assert.equal(job.state,"created");source.amount=99;assert.equal(job.start(),true);assert.deepEqual(await Host.waitForJob(job),{state:"finished",value:2});assert.equal(value("entered"),1);assert.throws(()=>root.run(()=>value("work")({amount:"wrong"})),Core.ContractError);assert.equal(value("entered"),1);checks.push("parameters before Job creation, deferred start and result contract");
 assert.equal(value("named").definition.name,"increment");assert.deepEqual(value("named").parse({id:"installed-call",name:"increment",arguments:{kind:"parsed",value:{amount:2}}}),{amount:2});checks.push("compiler-generated named tool metadata");
 const slow=root.run(()=>value("slow")(3));await new Promise(resolve=>setImmediate(resolve));assert.equal(slow.cancel("installed cancel"),true);assert.equal(slow.outcome,undefined);assert.deepEqual(await Host.waitForJob(slow),{state:"cancelled",reason:"installed cancel"});assert.equal(value("ioDone"),true);assert.equal(value("cleaned"),1);checks.push("actual Host completion and native finally before cancelled outcome");
 const used=await prepare("const once=1;");session.execute(used);assert.throws(()=>session.execute(used),Compiler.CompilationError);assert.throws(()=>session.execute({...used}),TypeError);checks.push("authentic once-only prepared handles");
 const diagnostics=await Host.waitForJob(root.run(()=>session.prepare({kind:"text",url:new URL("invalid.ts",baseURL),text:"const wrong:number='text';"})));assert.equal(diagnostics.state,"finished");assert.equal(diagnostics.value.kind,"diagnostics");assert.ok(diagnostics.value.diagnostics.some(d=>d.code==="ts:2322"&&d.span));checks.push("real fixed TypeScript diagnostic");
 await writeFile(new URL("dependency.ts",baseURL),"export const object={version:2}; export const token=Symbol();");await execute("import {object as changed} from './dependency.js';","changed.ts");assert.notEqual(value("changed"),original);assert.equal(original.version,1);assert.equal(value("changed").version,2);checks.push("changed module version without replacing old references");
 const fixed=await prepare("const afterClose=7; afterClose;","after-close.ts");const closing=compiler.close();assert.equal(compiler.close(),closing);await closing;assert.equal(session.execute(fixed).value,7);assert.throws(()=>root.run(()=>compiler.compile({kind:"text",url:new URL("closed.ts",baseURL),text:"1"},state.snapshot())),Compiler.CompilationError);checks.push("Compiler closure and neutral fixed prepared execution");
 for(const old of ["@bitagent/core/pi","@bitagent/core/skills","@bitagent/core/node/session"])assert.throws(()=>import.meta.resolve(old),error=>error.code==="ERR_PACKAGE_PATH_NOT_EXPORTED");checks.push("no MVP export route");
 console.log(JSON.stringify({node:process.version,resolved:Object.fromEntries(["@bitagent/core","@bitagent/core/host","@bitagent/core/state","@bitagent/core/compiler","@bitagent/core/node"].map(name=>[name,import.meta.resolve(name)])),exports:{Core:Object.keys(Core).sort(),Host:Object.keys(Host).sort(),State:Object.keys(State).sort(),Compiler:Object.keys(Compiler).sort(),Node:Object.keys(Node).sort()},checks},null,2));
} finally {
 const services=await Promise.allSettled([session.close(),compiler.close(),root.close()]);
 const files=await Promise.allSettled([rm(directory,{recursive:true,force:true})]);
 const errors=[...services,...files].filter(result=>result.status==="rejected").map(result=>result.reason);
 if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,"Installed consumer resource shutdown failed");
}
