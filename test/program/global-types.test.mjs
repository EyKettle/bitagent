import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ContractError} from '@bitagent/core';
import {waitForJob} from '@bitagent/core/host';
import {application} from './fixtures/application.mjs';

async function sources(a){
 await a.write('global-contract.ts',"import {contract} from '@bitagent/core'; export const value=contract<GlobalData>();");
 await a.write('one-global.ts','export {}; declare global {interface GlobalData {n:number}}');
 await a.write('two-global.ts','export {}; declare global {interface GlobalData {m:string}}');
}
test('adopted global augmentation changes generated contracts while old objects retain their shape',async t=>{
 const a=await application(t);await sources(a);
 assert.equal((await a.execute("import './one-global.js'; import {value as before} from './global-contract.js';",'one.ts')).kind,'returned');
 const before=a.value('before');assert.deepEqual(before.parse({n:1}),{n:1});
 assert.equal((await a.execute("import './two-global.js'; import {value as after} from './global-contract.js';",'two.ts')).kind,'returned');
 const after=a.value('after');assert.notEqual(after,before);assert.deepEqual(after.parse({n:1,m:'new'}),{n:1,m:'new'});assert.throws(()=>before.parse({n:1,m:'new'}),ContractError);
});
test('unchanged global environment does not change a cached module through fixed declaration copies',async t=>{
 const a=await application(t);await sources(a);await a.execute("import './one-global.js'; import {value as before} from './global-contract.js';",'one.ts');const before=a.value('before');
 await a.execute('const unrelated=1;','unrelated.ts');await a.execute("import './one-global.js'; import {value as again} from './global-contract.js';",'again.ts');assert.equal(a.value('again'),before);
});
test('inactive historical declarations do not add removed global context to a later program',async t=>{
 const a=await application(t);await sources(a);await a.execute("import './one-global.js'; import {value as before} from './global-contract.js';",'one.ts');const old=a.value('before');a.state.remove(...a.state.snapshot().definitions);
 await a.execute("import './two-global.js'; import {value as current} from './global-contract.js';",'two.ts');const current=a.value('current');assert.deepEqual(current.parse({m:'new'}),{m:'new'});assert.deepEqual(old.parse({n:1}),{n:1});assert.throws(()=>current.parse({n:1,m:'new'}),ContractError);
});
test('equivalent captured global type dependencies do not create another module instance',async t=>{
 const a=await application(t);await a.write('data.ts','export interface Data {name:string}');await a.write('global.ts',"import type {Data} from './data.js'; export {}; declare global {interface GlobalData {nested:Data}}");await a.write('contract.ts',"import {contract} from '@bitagent/core'; export const value=contract<GlobalData>();");await a.execute("import './global.js'; import {value as before} from './contract.js';",'before.ts');const before=a.value('before');await a.execute("import {value as after} from './contract.js';",'after.ts');assert.equal(a.value('after'),before);assert.deepEqual(before.parse({nested:{name:'Ada'}}),{nested:{name:'Ada'}});
});
test('global augmentation in the actual command entry is not invented as a named State binding',async t=>{
 const a=await application(t);const result=await a.execute("export {}; declare global {interface EntryData {n:number}}; import {contract} from '@bitagent/core'; const value=contract<EntryData>();");assert.equal(result.kind,'returned');assert.deepEqual(a.value('value').parse({n:1}),{n:1});assert.equal(a.state.find('global'),undefined);
});
test('earlier complete return types cannot acquire later ambient fields',async t=>{
 const a=await application(t);await sources(a);await a.execute("import './one-global.js';import{value as before}from'./global-contract.js';",'before.ts');await a.execute("import './two-global.js';import{value as after}from'./global-contract.js';",'after.ts');const job=a.root.run(()=>a.session.prepare(a.input("const parsed=before.parse({n:1});const wrong:string=parsed.m;",'fixed.ts')));const outcome=await waitForJob(job);assert.equal(outcome.state,'finished');assert.equal(outcome.value.kind,'diagnostics');assert(outcome.value.diagnostics.some(d=>d.code==='ts:2339'));
});
test('fixed global types retain imported bases and recursive private dependencies',async t=>{
 const a=await application(t);await a.write('data.ts','export interface Base{n:number}');await a.write('global.ts',"import type{Base}from'./data.js';interface Private{label:string;next?:GlobalData};export{};declare global{interface GlobalData extends Base {nested:Private}}");await a.write('contract.ts',"import{contract}from'@bitagent/core';export const value=contract<GlobalData>();");await a.execute("import './global.js';import{value as before}from'./contract.js';",'before.ts');await a.execute("const parsed=before.parse({n:1,nested:{label:'A'}});const n:number=parsed.n;const label:string=parsed.nested.label;label",'read.ts');assert.equal(a.value('label'),'A');
});
test('global script declarations and type queries remain fixed instead of merging again',async t=>{
 const a=await application(t);await a.write('globals.d.ts','interface ScriptData{n:number};declare var globalValue:ScriptData;');await a.write('use.ts',"/// <reference path='./globals.d.ts'/>\nimport{contract}from'@bitagent/core';export const value=contract<typeof globalValue>();");await a.execute("import{value as before}from'./use.js';",'before.ts');await a.write('later.ts','export{};declare global{interface ScriptData{m:string}}');await a.execute("import './later.js';",'later-input.ts');const job=a.root.run(()=>a.session.prepare(a.input("const parsed=before.parse({n:1});parsed.m;",'fixed.ts')));const outcome=await waitForJob(job);assert.equal(outcome.state,'finished');assert.equal(outcome.value.kind,'diagnostics');assert(outcome.value.diagnostics.some(d=>d.code==='ts:2339'));
});
