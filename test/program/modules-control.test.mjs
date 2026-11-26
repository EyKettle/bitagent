import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Job} from '@bitagent/core';
import {waitForJob} from '@bitagent/core/host';
import {application} from './fixtures/application.mjs';

test('captured source and versions preserve old references, reuse, changed imports and declarations',async t=>{
 const a=await application(t);await a.write('dep.ts','export let count=1; export const object={n:1}; export function get(){return count++};');
 const p=await a.prepare("import {object,get} from './dep.js'; object",'first.ts');assert.equal(p.kind,'ready');await a.write('dep.ts','export let count=10; export const object={n:10}; export function get(){return count++};');
 const old=a.session.execute(p.input);assert.equal(old.value.n,1);const get=a.value('get');assert.equal(get(),1);assert.equal(get(),2);
 await a.execute("import {object as newer,get as newGet} from './dep.js'; newer",'second.ts');assert.equal(a.value('newer').n,10);assert.equal(a.value('newGet')(),10);assert.equal(get(),3);
 await a.execute("import {object as again} from './dep.js'; again",'third.ts');assert.equal(a.value('again'),a.value('newer'));
 a.state.remove(a.state.find('object'));assert.equal(old.value.n,1);await a.execute('const observed=newer.n;');assert.equal(a.value('observed'),10);
});

test('native cyclic modules keep live bindings and cached initialization failure',async t=>{
 const a=await application(t);await a.write('a.ts',"import {fromB} from './b.js'; export let value=1; export function read(){return fromB()};");await a.write('b.ts',"import {value} from './a.js'; export function fromB(){return value};");
 const run=await a.execute("import {read} from './a.js'; read()",'cycle.ts');assert.equal(run.value,1);
 await a.write('broken.ts','export const error={reason:"once"}; throw error;');const one=await a.execute("import './broken.js';",'broken1.ts');const two=await a.execute("import './broken.js';",'broken2.ts');assert.equal(one.kind,'threw');assert.equal(two.error,one.error);
});

test('root-owned business Jobs survive input return and compiler cancellation joins real work',async t=>{
 const a=await application(t);await a.execute("import {Job} from '@bitagent/core'; import {fromAsync} from '@bitagent/core/host'; const work=Job.spawn(function*(){yield* fromAsync(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));});");const work=a.value('work');assert.equal(work.state,'generating');work.cancel('stop');assert.equal((await waitForJob(work)).state,'cancelled');
 const text=Array.from({length:1000},(_,i)=>`const v${i}=${i};`).join('\n');const job=a.root.run(()=>a.session.prepare(a.input(text)));await new Promise(r=>setImmediate(r));assert.equal(job.cancel('compile stop'),true);const control=a.root.run(()=>Job.spawn(function*(){return 1;}));assert.equal((await waitForJob(control)).value,1);assert.equal((await waitForJob(job)).state,'cancelled');assert.equal(a.state.find('v0'),undefined);
});

test('type-only source changes are new versions and unrelated State members do not replace modules',async t=>{
 const a=await application(t);await a.write('stable.ts','export interface Item {n:number}; export const object={n:1};');
 await a.execute("import {object as first} from './stable.js';",'one.ts');const first=a.value('first');
 await a.execute('const irrelevant=true;');await a.execute("import {object as same} from './stable.js';",'two.ts');assert.equal(a.value('same'),first);
 await a.write('stable.ts','export interface Item {n:number; extra?:string}; export const object={n:1};');await a.execute("import {object as changed} from './stable.js';",'three.ts');assert.notEqual(a.value('changed'),first);
});
