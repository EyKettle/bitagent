import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';
import {waitForJob} from '@bitagent/core/host';
import {observeCompilation} from '../../dist/node/measurements.js';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';

test('unrelated global augmentation retains an unchanged unique-symbol declaration',async t=>{
  const a=await application(t);
  await a.write('globals.d.ts','declare const GlobalToken:unique symbol;interface Data{n:number}');
  await a.execute("/// <reference path='./globals.d.ts'/>\nconst before=():typeof GlobalToken=>{throw new Error('not invoked')};",'before.ts');
  await a.write('later.ts','export{};declare global{interface Data{m:string}}');
  const result=await a.execute("/// <reference path='./globals.d.ts'/>\nimport './later.js';const now=():typeof GlobalToken=>{throw new Error('not invoked')};const checked:typeof before=now;",'after.ts');
  assert.equal(result.kind,'returned');
});

test('nominal binding preserves UTF-16 diagnostics after replacing declarations in the same input URL',async t=>{
  const a=await application(t);
  await a.execute("export{};declare global{const PositionToken:unique symbol;}const prior=()=>PositionToken;",'same.ts');
  const code="// 🛰 diagnostic\nexport{};declare global{const PositionToken:unique symbol;}const broken:number='bad';";
  const prepared=await a.prepare(code,'same.ts');
  assert.equal(prepared.kind,'diagnostics');
  const diagnostic=prepared.diagnostics.find(d=>d.code==='ts:2322');
  assert.ok(diagnostic,JSON.stringify(prepared.diagnostics));
  assert.deepEqual(diagnostic.span,{url:new URL('same.ts',a.baseURL).href,start:code.indexOf('broken'),length:'broken'.length});
});


test('fixed global class and enum aliases retain generic, member and namespace types',async t=>{
  const a=await application(t);
  await a.write('kinds.d.ts','declare class Box<T=number>{private brand;readonly value:T;constructor(value:T)}declare namespace Box{type Inner=string}declare enum Mode{A=0,B=1}interface Data{n:number}');
  await a.execute("/// <reference path='./kinds.d.ts'/>\nconst beforeBox=(value:Box<string>):Box<string>=>value;const beforeMode=(value:Mode.A):Mode.A=>value;",'before.ts');
  await a.write('later.ts','export{};declare global{interface Data{m:string}}');
  const execution=await a.execute("/// <reference path='./kinds.d.ts'/>\nimport './later.js';const checkedBox:typeof beforeBox=(value:Box<string>)=>value;const checkedMode:typeof beforeMode=(value:Mode.A)=>value;const inner:Box.Inner='x';",'after.ts');
  assert.equal(execution.kind,'returned');assert.equal(a.value('inner'),'x');
});

test('nominal binding does not replace actual global runtime constructor names',async t=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'NominalRuntimeBox');
  Object.defineProperty(globalThis,'NominalRuntimeBox',{configurable:true,writable:true,value:class {brand=0;constructor(value){this.value=value;}}});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'NominalRuntimeBox',descriptor);else delete globalThis.NominalRuntimeBox;});
  const a=await application(t);
  const declaration='class NominalRuntimeBox{private brand:number;value:number;constructor(value:number)}';
  await a.execute('export{};declare global{'+declaration+'}const before=(value:NominalRuntimeBox)=>value;','same.ts');
  const execution=await a.execute('export{};declare global{'+declaration+'interface Later{m:string}}const now=(value:NominalRuntimeBox)=>value;const checked:typeof before=now;new NominalRuntimeBox(7).value;','same.ts');
  assert.equal(execution.kind,'returned');assert.equal(execution.value,7);
});

test('unchanged nominal declarations in a global namespace retain their identity',async t=>{
  const a=await application(t);
  await a.write('space.d.ts','declare namespace Space{class Box{private brand;}}interface Data{n:number}');
  await a.execute("/// <reference path='./space.d.ts'/>\nconst before=(value:Space.Box)=>value;",'before.ts');
  await a.write('later.ts','export{};declare global{interface Data{m:string}}');
  const execution=await a.execute("/// <reference path='./space.d.ts'/>\nimport './later.js';const checked:typeof before=(value:Space.Box)=>value;",'after.ts');
  assert.equal(execution.kind,'returned');
});

test('unchanged global nominal declarations retain their fixed identity after physical Worker restart',async t=>{
  const a=await application(t);
  await a.write('restart.d.ts','declare const RestartToken:unique symbol;interface RestartData{n:number}');
  await a.execute("/// <reference path='./restart.d.ts'/>\nconst before=():typeof RestartToken=>{throw new Error('not invoked')};",'before.ts');
  let ready;const entered=new Promise(resolve=>{ready=resolve;});
  const detach=observeCompilation(event=>{if(event.phase==='checking')ready();});t.after(detach);
  const job=a.root.run(()=>a.session.prepare(a.input(Array.from({length:1000},(_,i)=>'const value'+i+'='+i+';').join('\n'),'large.ts')));
  await entered;assert.equal(job.cancel('restart-global'),true);
  const outcome=await waitForJob(job);detach();
  assert.equal(outcome.state,'cancelled');assert.equal(outcome.reason,'restart-global');assert.equal(a.compiler.state,'open');
  const execution=await a.execute("/// <reference path='./restart.d.ts'/>\nexport{};declare global{interface RestartData{m:string}}const now=():typeof RestartToken=>{throw new Error('not invoked')};const checked:typeof before=now;",'after.ts');
  assert.equal(execution.kind,'returned');assert.equal(a.state.find('value0'),undefined);
});

test('a method-local type parameter does not hide another member global dependency',async t=>{
  const a=await application(t);
  await a.execute('export{};declare global{interface GlobalPayload{n:number}class ShadowBox{private brand:void;read():GlobalPayload;generic<GlobalPayload>(v:GlobalPayload):GlobalPayload;}}const before=(box:ShadowBox)=>box.read();','before.ts');
  const current=await a.prepare('export{};declare global{interface GlobalPayload{m:string}}const now=(box:ShadowBox)=>box.read();const accept=(value:ReturnType<typeof now>)=>value.m;','after.ts');
  assert.equal(current.kind,'ready',JSON.stringify(current));assert.equal(a.session.execute(current.input).kind,'returned');
  const old=await a.prepare('const wrong=(value:ReturnType<typeof before>)=>value.m;','old.ts');assert.equal(old.kind,'diagnostics');assert.ok(old.diagnostics.some(d=>d.code==='ts:2339'));
});

test('purely local generic parameters keep nominal identity across unrelated global changes',async t=>{
  const a=await application(t);
  await a.execute('export{};declare global{interface ParameterOnly{n:number}class GenericBox{private brand:void;identity<ParameterOnly>(value:ParameterOnly):ParameterOnly;}}const before=(value:GenericBox)=>value;','before.ts');
  const current=await a.prepare('export{};declare global{interface ParameterOnly{m:string}}const checked:typeof before=(value:GenericBox)=>value;','after.ts');assert.equal(current.kind,'ready',JSON.stringify(current));assert.equal(a.session.execute(current.input).kind,'returned');
});

test('actual imported aliases are not unrelated same-named global dependencies',async t=>{
  const a=await application(t);
  await a.write('local-types.ts','export interface Data { n:number }');
  await a.write('global-box.d.ts',"import type {Data as ImportPayload} from './local-types.js';export{};declare global{class ImportedBox{private brand:void;read():ImportPayload;}}");
  await a.write('unrelated-global.ts','export{};declare global{interface ImportPayload{other:number}}');
  await a.execute("import type {} from './global-box.js';import './unrelated-global.js';const before=(box:ImportedBox)=>box;",'before.ts');
  const prepared=await a.prepare('export{};declare global{interface ImportPayload{extra:string}}const checked:typeof before=(box:ImportedBox)=>box;','after.ts');assert.equal(prepared.kind,'ready',JSON.stringify(prepared));assert.equal(a.session.execute(prepared.input).kind,'returned');
});

test('actual imported type changes still produce current nominal dependencies',async t=>{
  const a=await application(t);
  await a.write('changed-data.ts','export interface ImportedData { n:number }');
  await a.write('changed-box.d.ts',"import type {ImportedData} from './changed-data.js';export{};declare global{class ChangedBox{private brand:void;read():ImportedData;}}");
  await a.execute("import type {} from './changed-box.js';const before=(box:ChangedBox)=>box.read();",'before.ts');
  await a.write('changed-data.ts','export interface ImportedData { n:number; m:string }');
  const prepared=await a.prepare("import type {} from './changed-box.js';const now=(box:ChangedBox)=>box.read();const accept=(value:ReturnType<typeof now>)=>value.m;",'after.ts');assert.equal(prepared.kind,'ready',JSON.stringify(prepared));assert.equal(a.session.execute(prepared.input).kind,'returned');
  const old=await a.prepare('const wrong=(value:ReturnType<typeof before>)=>value.m;','old.ts');assert.equal(old.kind,'diagnostics');assert.ok(old.diagnostics.some(d=>d.code==='ts:2339'));
});

test('caller input location is not standard-library ownership for its original complete Type',async t=>{
  const a=await application(t);
  const location=new URL('bitagent-caller-input.mts',pathToFileURL(ts.getDefaultLibFilePath({target:ts.ScriptTarget.ES2022}))).href;
  const first=await a.execute('export{};declare global{interface CallerLocationData{n:number}}const stored:CallerLocationData={n:1};',location);
  assert.equal(first.kind,'returned');
  const prepared=await a.prepare('export{};declare global{interface CallerLocationData{m:string}}const invalid:string=stored.m;','later.ts');
  assert.equal(prepared.kind,'diagnostics',JSON.stringify(prepared));
  assert.ok(prepared.diagnostics.some(d=>d.code==='ts:2339'&&d.message.includes("'m'")),JSON.stringify(prepared.diagnostics));
});
