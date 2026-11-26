import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('a structurally identical ordinary function retains its original call and exception',async t=>{
 const a=await application(t);const outcome=await a.execute("import {contract} from '@bitagent/core'; const original=new Error('ordinary'); const ordinary:typeof contract=()=>{throw original}; ordinary<number>();");assert.equal(outcome.kind,'threw');assert.equal(outcome.error,a.value('original'));
});
test('actual imported, fixed-module and same-function State aliases remain Core generators',async t=>{
 const a=await application(t);await a.write('alias.ts',"import {contract} from '@bitagent/core'; export const shape=contract;");await a.execute("import {contract as make} from '@bitagent/core'; const shared=make; const value=make<number>().parse(1);");assert.equal(a.value('value'),1);await a.execute("import {shape} from './alias.js'; const first=shape<number>().parse(2);");assert.equal(a.value('first'),2);await a.execute("import {shape as later} from './alias.js'; const second=later<number>().parse(3); const third=shared<number>().parse(4);",'next.ts');assert.equal(a.value('second'),3);assert.equal(a.value('third'),4);
});

test('a fixed module ordinary function keeps its original identity after declaration reuse',async t=>{
 const a=await application(t);await a.write('ordinary.ts',"import {contract} from '@bitagent/core'; export const ordinary:typeof contract=()=>{throw new Error('ordinary-module')};");const first=await a.execute("import {ordinary} from './ordinary.js'; ordinary<number>();");assert.equal(first.kind,'threw');assert.equal(first.error.message,'ordinary-module');const second=await a.execute("import {ordinary as later} from './ordinary.js'; later<number>();",'next.ts');assert.equal(second.kind,'threw');assert.equal(second.error.message,'ordinary-module');
});
test('a prepared constructor call observes the actual mutable same-type binding at execution',async t=>{
 const a=await application(t);await a.execute("import {contract} from '@bitagent/core'; let shared=contract; const original=new Error('changed'); function change(){shared=()=>{throw original};}");const prepared=await a.prepare('shared<number>()','use.ts');assert.equal(prepared.kind,'ready');a.value('change')();const executed=a.session.execute(prepared.input);assert.equal(executed.kind,'threw');assert.equal(executed.error,a.value('original'));
});
