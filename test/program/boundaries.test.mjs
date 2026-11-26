import assert from 'node:assert/strict';
import {test} from 'node:test';
import {symlink,mkdir} from 'node:fs/promises';
import {ContractError} from '@bitagent/core';
import {createTypeScriptCompiler} from '@bitagent/core/node';
import {versionRegistry} from '../../dist/node/versions.js';
import {application} from './fixtures/application.mjs';

test('native entry exports and live compound, logical and destructuring assignments retain language semantics',async t=>{
 const a=await application(t);await a.execute('export let count=0; export let big=1n; export const object={n:2}; export default function named(){return count};');
 let execution=await a.execute('count ||= 3; count &&= 4; count ??= 7; big++; ({n:count}=object); [count]=[9]; count');assert.equal(execution.kind,'returned');assert.equal(execution.value,9);assert.equal(a.value('count'),9);assert.equal(a.value('big'),2n);assert.equal(a.value('named')(),9);
 execution=await a.execute('export default function(){return 1}; const __bitAcquire=1; __bitAcquire');assert.equal(execution.kind,'returned');assert.equal(execution.value,1);
});
test('inferred import type declarations remain fixed after the dependency changes',async t=>{
 const a=await application(t);await a.write('dep.ts','export interface Item {n:number}; export function get():Item{return {n:1}};');
 await a.execute("import {get} from './dep.js'; const original=get();",'old.ts');await a.write('dep.ts','export interface Item {n:string}; export function get():Item{return {n:"new"}};');
 const execution=await a.execute("import {contract} from '@bitagent/core'; const fixed=contract<typeof original>(); fixed.parse(original)");assert.equal(execution.kind,'returned');assert.deepEqual(execution.value,{n:1});assert.throws(()=>a.value('fixed').parse({n:'new'}),ContractError);
});
test('optional and repeated tail tuples retain exact structural bounds',async t=>{
 const a=await application(t);await a.execute("import {contract} from '@bitagent/core'; const optional=contract<[number,string?]>(); const repeated=contract<[number,...string[]]>();");
 assert.deepEqual(a.value('optional').parse([1]),[1]);assert.deepEqual(a.value('optional').parse([1,'x']),[1,'x']);assert.throws(()=>a.value('optional').parse([1,undefined]),ContractError);assert.throws(()=>a.value('optional').parse([1,'x','y']),ContractError);
 assert.deepEqual(a.value('repeated').parse([1,'a','b']),[1,'a','b']);assert.throws(()=>a.value('repeated').parse([1,3]),ContractError);
 assert.equal(a.value('optional').schema.$defs.type0.maxItems,2);assert.equal(a.value('repeated').schema.$defs.type0.items.type,'string');
});
test('source validation precedes Job creation and source identities resolve file aliases',async t=>{
 const a=await application(t);for(const url of [new URL('https://invalid.example/x.ts'),new URL('dir/',a.baseURL),new URL('input.ts?q=1',a.baseURL),new URL('input.ts#x',a.baseURL)]) assert.throws(()=>a.root.run(()=>a.session.prepare({kind:'text',url,text:''})),TypeError);
 await mkdir(new URL('actual-dir',a.baseURL));assert.throws(()=>a.root.run(()=>a.session.prepare(a.input('', 'actual-dir'))),TypeError);assert.throws(()=>createTypeScriptCompiler({baseURL:new URL('input.ts',a.baseURL)}),TypeError);
 await a.write('real.ts','export const value={n:1};');await symlink(new URL('real.ts',a.baseURL),new URL('alias.ts',a.baseURL));await a.execute("import {value as original} from './real.js'",'one.ts');await a.execute("import {value as alias} from './alias.js'",'two.ts');assert.equal(a.value('alias'),a.value('original'));
});
test('digest equality cannot merge different captured contents',()=>{const version=versionRegistry(()=> 'forced-collision');assert.equal(version('first'),version('first'));assert.notEqual(version('first'),version('second'));assert.equal(version('second'),version('second'));});

test('special data field and definition names do not change prototypes',async t=>{
 const a=await application(t);await a.execute("import {contract} from '@bitagent/core'; const parser=contract<{__proto__:{n:number}}>(); const __proto__=3;");
 const data=JSON.parse('{"__proto__":{"n":1}}');const result=a.value('parser').parse(data);assert.equal(Object.hasOwn(result,'__proto__'),true);assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.deepEqual(result.__proto__,{n:1});assert.equal(a.value('__proto__'),3);
});

test('native module.exports interoperability cannot replace the input display binding',async t=>{
 const a=await application(t);const execution=await a.execute("const overridden={n:1}; export {overridden as 'module.exports'}; 42");assert.equal(execution.kind,'returned');assert.equal(execution.value,42);assert.deepEqual(a.value('overridden'),{n:1});
});
