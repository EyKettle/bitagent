import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('a same-named ordinary function under a virtual package directory is not a Core generator',async t=>{
 const a=await application(t);const input={kind:'text',url:new URL('../../dist/pretender.ts',import.meta.url),text:'function contract<T>(){return "ordinary"}; const value=contract<number>(); value'};
 const {waitForJob}=await import('@bitagent/core/host');const outcome=await waitForJob(a.root.run(()=>a.session.prepare(input)));assert.equal(outcome.state,'finished');assert.equal(outcome.value.kind,'ready');assert.equal(a.session.execute(outcome.value.input).value,'ordinary');
});
test('a declaration source without an execution artifact is diagnosed rather than readied',async t=>{
 const a=await application(t);const result=await a.prepare('declare const value:number;','input.d.ts');assert.equal(result.kind,'diagnostics');assert.ok(result.diagnostics.some(d=>d.severity==='error'));assert.equal(a.state.revision,0);
});

test('decoded identifiers in nested scopes cannot shadow generated accessors',async t=>{
 const a=await application(t);const text=String.raw`import {contract} from '@bitagent/core'; function make(){const \u005f\u005fbitGenerated=1; return contract<number>()}; const checked=make(); checked.parse(3)`;const execution=await a.execute(text);assert.equal(execution.kind,'returned');assert.equal(execution.value,3);
});
