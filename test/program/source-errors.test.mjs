import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('invalid constructor calls produce real TypeScript diagnostics without execution artifacts',async t=>{
 const a=await application(t);for(const text of ["import {tool} from '@bitagent/core'; tool<{value:number},number>('missing');", "import {defineFunction} from '@bitagent/core'; defineFunction<(value:number)=>number>();"]){const result=await a.prepare(text);assert.equal(result.kind,'diagnostics');assert.ok(result.diagnostics.some(d=>d.code==='ts:2554'&&d.span));assert.equal(a.state.revision,0);}
});
