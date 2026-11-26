import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('unchanged module instances keep nominal declaration identity after unrelated inputs',async t=>{
 const a=await application(t);await a.write('unique.ts','export const token=Symbol();');await a.execute("import {token as first} from './unique.js';",'one.ts');await a.execute('const unrelated=1;');const prepared=await a.prepare("import {token as same} from './unique.js'; const accepted: typeof first = same;",'two.ts');assert.equal(prepared.kind,'ready',JSON.stringify(prepared));const execution=a.session.execute(prepared.input);assert.equal(execution.kind,'returned');assert.equal(a.value('same'),a.value('first'));assert.equal(a.value('accepted'),a.value('first'));
});
