import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('type-only imported classes publish only their original type, never a fabricated value',async t=>{
 const a=await application(t);await a.write('class.ts','export class Item {n=1};');await a.execute("import type {Item as PureItem} from './class.js';");assert.equal(a.state.find('PureItem')?.spec.kind,'type');assert.throws(()=>a.value('PureItem'),error=>error.kind==='missing-value');const result=await a.prepare('const forbidden=new PureItem();');assert.equal(result.kind,'diagnostics');assert.equal(a.state.find('forbidden'),undefined);
});
test('identical declaration text cannot reuse a previous unique symbol type identity',async t=>{
 const a=await application(t);await a.execute('const token=Symbol();','token.ts');await a.execute('const alias:typeof token=token;','alias.ts');const original=a.value('alias');a.state.remove(a.state.find('token'));await a.execute('const token=Symbol();','token.ts');assert.notEqual(a.value('token'),original);const result=await a.prepare('const wrong:typeof token=alias;');assert.equal(result.kind,'diagnostics');assert.ok(result.diagnostics.some(d=>d.code==='ts:2719'),JSON.stringify(result));
});
