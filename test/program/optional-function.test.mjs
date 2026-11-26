import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ContractError} from '@bitagent/core';
import {waitForJob} from '@bitagent/core/host';
import {application} from './fixtures/application.mjs';

test('optional union parameters adopt every concrete branch and omission',async t=>{
 const a=await application(t);await a.execute("import {defineFunction} from '@bitagent/core'; const kind=defineFunction<(x?:string|number)=>string>(function*(_,x){return typeof x});");
 const fn=a.value('kind');for(const [args,expected] of [[[],'undefined'],[[3],'number'],[['x'],'string']]){const outcome=await waitForJob(a.root.run(()=>fn(...args)));assert.equal(outcome.state,'finished');assert.equal(outcome.value,expected);}assert.throws(()=>a.root.run(()=>fn({})),ContractError);
});
