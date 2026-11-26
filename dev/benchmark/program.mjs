import assert from 'node:assert/strict';
import {observeCompilation} from "../../dist/node/measurements.js";
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createState} from '@bitagent/core/state';
import {createTypeScriptCompiler} from '@bitagent/core/node';
import {createExecutionRoot,createCompilerSession,waitForJob} from '@bitagent/core/host';
import {Job} from '@bitagent/core';
const output=process.argv[2];if(!output)throw new Error('An explicit new output path is required');
const workloads=JSON.parse(await fs.readFile(new URL('./fixtures/workloads.json',import.meta.url),'utf8'));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bitagent-benchmark-')),baseURL=pathToFileURL(directory+path.sep),root=createExecutionRoot(),compiler=createTypeScriptCompiler({baseURL}),sessions=[],samples={warm:{},cold:[],control:[],changed:[],stateScale:{},sourceScale:{},continuous:[]};
const session=()=>{const state=createState();const value=createCompilerSession({state,root,compiler});sessions.push(value);return value;};
async function prepare(s,text){const start=performance.now();const job=root.run(()=>s.prepare({kind:'text',url:new URL("input.ts",baseURL),text}));const result=await waitForJob(job);const duration=performance.now()-start;if(result.state!=='finished'||result.value.kind!=='ready')throw new Error(JSON.stringify(result));return {input:result.value.input,duration};}
const returned=result=>{if(result.kind==='threw')throw result.error;assert.equal(result.kind,'returned');return result.value;};
const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:sorted.length,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};};
try{
 await fs.writeFile(new URL('dependency.ts',baseURL),workloads.dependency);
 for(const item of workloads.warm){const record={prepare:[],execute:[],state:[]};for(let i=0;i<35;i++){const s=session(),p=await prepare(s,item.text);const execute=performance.now();const result=s.execute(p.input);const execution=performance.now()-execute;returned(result);const st=performance.now();const view=s.applicationState.snapshot();s.applicationState.find('item');s.applicationState.aliases({});s.applicationState.remove(...view.definitions.slice(-1));const observation=performance.now()-st;if(i>=5){record.prepare.push(p.duration);record.execute.push(execution);record.state.push(observation);}await s.close();}samples.warm[item.name]=record;}
 for(let i=0;i<5;i++){const c=createTypeScriptCompiler({baseURL}),s=createCompilerSession({state:createState(),root,compiler:c});const p=await prepare(s,'1+2');samples.cold.push(p.duration);assert.equal(returned(s.execute(p.input)),3);await s.close();await c.close();}
 const s=session();for(let i=0;i<35;i++){const p=await prepare(s,`const continuous${i}=${i}; continuous${i}`);assert.equal(returned(s.execute(p.input)),i);if(i>=5)samples.continuous.push(p.duration);}
 for(const n of workloads.scales.definitions){const values=[];for(let i=0;i<35;i++){const s=session();const p=await prepare(s,Array.from({length:n},(_,i)=>`const definition${i}={value:${i}};`).join('\n'));returned(s.execute(p.input));const start=performance.now();const view=s.applicationState.snapshot();s.applicationState.find('definition0');s.applicationState.aliases({});s.applicationState.remove(view.definitions.at(-1));const duration=performance.now()-start;assert.equal(view.definitions.length,n);assert.equal(s.applicationState.value(s.applicationState.find('definition0')).value,0);if(i>=5)values.push(duration);await s.close();}samples.stateScale[n]=values;}
 for(const n of workloads.scales.sourceLines){const record={prepare:[],execute:[]};for(let i=0;i<35;i++){const s=session();const p=await prepare(s,Array.from({length:n},(_,i)=>`const source${i}=${i};`).join('\n'));const start=performance.now();const execution=s.execute(p.input);const duration=performance.now()-start;returned(execution);assert.equal(s.applicationState.snapshot().definitions.length,n);assert.equal(s.applicationState.value(s.applicationState.find('source'+(n-1))),n-1);if(i>=5){record.prepare.push(p.duration);record.execute.push(duration);}await s.close();}samples.sourceScale[n]=record;}
 for(let i=0;i<30;i++){await fs.writeFile(new URL('dependency.ts',baseURL),workloads.changed+`\nexport const version=${i};`);const s=session();const p=await prepare(s,workloads.warm.at(-1).text);samples.changed.push(p.duration);assert.equal(returned(s.execute(p.input)).count,3);await s.close();}
 for(let i=0;i<30;i++){const s=session();let id,completed,detach;const started=new Promise(resolve=>{detach=observeCompilation(event=>{if(event.phase==='checking'&&id===undefined){id=event.id;resolve(event);}else if(event.phase==='completed'&&event.id===id)completed=event.workerTime;});});const job=root.run(()=>s.prepare({kind:'text',url:new URL("control.ts",baseURL),text:Array.from({length:1000},(_,i)=>`const busy${i}=${i};`).join('\n')}));const entered=await started;const scheduled=performance.now();await new Promise(r=>setImmediate(r));const admitted=performance.now();void job.state;const accepted=job.cancel('control benchmark');const admission=performance.now()-admitted;const ended=performance.now();const outcome=await waitForJob(job);detach();samples.control.push({workerEntered:entered.workerTime,workerCompleted:completed??null,admitted,activeAtAdmission:admitted>=entered.workerTime&&(completed===undefined||admitted<=completed),accepted,outcome:outcome.state,scheduled:ended-scheduled,admission,terminal:performance.now()-ended});await s.close();}
 const warm=Object.fromEntries(Object.entries(samples.warm).map(([name,r])=>[name,{prepare:summary(r.prepare),execute:summary(r.execute),state:summary(r.state)}]));const control={scheduling:summary(samples.control.map(r=>r.scheduled)),admission:summary(samples.control.map(r=>r.admission)),terminal:summary(samples.control.map(r=>r.terminal))};
 const budget={prepare:Object.values(warm).every(r=>r.prepare.p95<=1000)&&summary(samples.continuous).p95<=1000,execute:Object.values(warm).every(r=>r.execute.p95<=100),state:Object.values(warm).every(r=>r.state.p95<=100),control:samples.control.every(sample=>sample.activeAtAdmission&&sample.accepted&&sample.outcome==="cancelled")&&control.scheduling.p95<=100&&control.admission.p95<=100};
 const result={environment:{node:process.version,platform:process.platform,arch:process.arch,kernel:os.release(),cpu:os.cpus()[0].model,memory:os.totalmem(),typescript:'5.9.3'},workloads,samples,summary:{warm,continuous:summary(samples.continuous),cold:summary(samples.cold),changed:summary(samples.changed),stateScale:Object.fromEntries(Object.entries(samples.stateScale).map(([n,v])=>[n,summary(v)])),sourceScale:Object.fromEntries(Object.entries(samples.sourceScale).map(([n,r])=>[n,{prepare:summary(r.prepare),execute:summary(r.execute)}])),control},budget,passed:Object.values(budget).every(Boolean)};
 await fs.writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({summary:result.summary,budget,passed:result.passed},null,2));if(!result.passed)process.exitCode=1;
}finally{
 const closed=await Promise.allSettled(sessions.map(s=>s.close()));
 const resources=await Promise.allSettled([compiler.close(),root.close()]);
 const removed=await Promise.allSettled([fs.rm(directory,{recursive:true,force:true})]);
 const errors=[...closed,...resources,...removed].filter(r=>r.status==='rejected').map(r=>r.reason);
 if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'Benchmark resource shutdown failed');
}

