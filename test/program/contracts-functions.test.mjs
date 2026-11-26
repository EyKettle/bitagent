import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ContractError,contract,defineFunction} from '@bitagent/core';
import {waitForJob} from '@bitagent/core/host';
import {application} from './fixtures/application.mjs';

test('concrete contracts adopt independent finite data without getters, coercion or cycles',async t=>{
 const a=await application(t);await a.execute("import {contract as checked} from '@bitagent/core'; interface Tree { /** label */ name:string; children?:Tree[] }; const parser=checked<Tree>();");
 const parser=a.value('parser'),input={name:'root',children:[{name:'child'}]},value=parser.parse(input);assert.deepEqual(value,input);assert.notEqual(value,input);assert.notEqual(value.children,input.children);assert.ok(Object.isFrozen(parser.schema));
 assert.throws(()=>parser.parse({name:'a',extra:1}),e=>e instanceof ContractError&&e.issues[0].path[0]==='extra');assert.throws(()=>parser.parse({name:2}),ContractError);assert.throws(()=>parser.parse({name:'a',children:undefined}),ContractError);
 let invoked=false;assert.throws(()=>parser.parse({get name(){invoked=true;return 'a'}}),ContractError);assert.equal(invoked,false);
 const cycle={name:'a'};cycle.children=[cycle];assert.throws(()=>parser.parse(cycle),ContractError);assert.throws(()=>parser.parse(Object.create({name:'a'})),ContractError);
 assert.throws(()=>contract(),TypeError);assert.throws(()=>defineFunction(function*(){}),TypeError);
});

test('unsupported data and overloaded/generic functions diagnose before usable output',async t=>{
 const a=await application(t);
 for(const text of ["import {contract} from '@bitagent/core'; const bad=contract<any>();","import {contract} from '@bitagent/core'; const bad=contract<{run():void}>();","import {contract} from '@bitagent/core'; const bad=contract<Promise<number>>();","import {contract} from '@bitagent/core'; const bad=contract<number|void>();","import {defineFunction} from '@bitagent/core'; const bad=defineFunction<<T>(x:T)=>T>(function*(_,x){return x;});"]){const result=await a.prepare(text);assert.equal(result.kind,'diagnostics',text);assert.ok(result.diagnostics.some(d=>d.severity==='error'));assert.equal(a.state.revision,0);}
});

test('business calls adopt before Job creation, manual startup and checked result',async t=>{
 const a=await application(t);await a.execute("import {defineFunction as make} from '@bitagent/core'; const transform=make<(input:{n:number})=>{n:number}>(function*(_,input){return {n:input.n+1};},{start:'manual'});");
 const transform=a.value('transform'),input={n:1},job=a.root.run(()=>transform(input));input.n=9;assert.equal(job.state,'created');job.start();const outcome=await waitForJob(job);assert.deepEqual(outcome,{state:'finished',value:{n:2}});
 assert.throws(()=>a.root.run(()=>transform({n:'wrong'})),ContractError);
 await a.execute("const invalid=make<()=>number>(function*(){return 'bad' as unknown as number;}); const unit=make<()=>void>(function*(){});");
 const bad=a.root.run(()=>a.value('invalid')());assert.equal((await waitForJob(bad)).state,'failed');assert.ok(bad.outcome.error instanceof ContractError);const unit=a.root.run(()=>a.value('unit')());assert.deepEqual(await waitForJob(unit),{state:'finished',value:undefined});
});

test('ordinary then fields, recursive containers, tools and generated-name hygiene remain concrete',async t=>{
 const a=await application(t);
 await a.execute("import {contract,tool} from '@bitagent/core'; type Nested=Nested[]; const recursive=contract<Nested>(); const ordinary=contract<{then:string}>(); const named=tool<{\n/** chosen */\nn:number\n},number>('increment',({n})=>n+1,{description:'explicit'}); const __bitEnvironment=4; const __bitDisplay=7; __bitEnvironment+__bitDisplay");
 assert.deepEqual(a.value('recursive').parse([[],[[]]]),[[],[[]]]);assert.deepEqual(a.value('ordinary').parse({then:'data'}),{then:'data'});
 const named=a.value('named');assert.equal(named.definition.name,'increment');assert.equal(named.definition.description,'explicit');assert.equal(named.definition.parameters.$defs.type0.properties.n.description,'chosen');assert.deepEqual(named.parse({id:'one',name:'increment',arguments:{kind:'parsed',value:{n:2}}}),{n:2});assert.throws(()=>named.read({}),TypeError);
 const result=await a.prepare('await Promise.resolve(1)');assert.equal(result.kind,'diagnostics');assert.ok(result.diagnostics.some(d=>d.code==='core:async-module'));
});
