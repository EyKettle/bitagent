import assert from 'node:assert/strict';
import {test} from 'node:test';
import {waitForJob} from '@bitagent/core/host';
import {observeCompilation} from '../../dist/node/measurements.js';
import {application} from './fixtures/application.mjs';

test('cancelled compilation waits for physical work and keeps stable module types after Worker restart',async t=>{
 const a=await application(t);await a.write('unique.ts','export const token=Symbol();');await a.execute("import {token as before} from './unique.js';");
 let ready;const entered=new Promise(resolve=>{ready=resolve});const detach=observeCompilation(event=>{if(event.phase==='checking')ready();});const job=a.root.run(()=>a.session.prepare(a.input(Array.from({length:1000},(_,i)=>'const value'+i+'='+i+';').join('\n'),'large.ts')));await entered;assert.equal(job.cancel('restart'),true);const outcome=await waitForJob(job);detach();assert.equal(outcome.state,'cancelled');assert.equal(outcome.reason,'restart');assert.equal(a.compiler.state,'open');
 const execution=await a.execute("import {token as after} from './unique.js'; const checked:typeof before=after;",'after.ts');assert.equal(execution.kind,'returned');assert.equal(a.value('checked'),a.value('before'));assert.equal(a.state.find('value0'),undefined);
});
