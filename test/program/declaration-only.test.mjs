import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('unchanged declaration-only imports retain their original nominal type through later inputs',async t=>{
 const a=await application(t);await a.write('decl.d.ts','export declare const token:unique symbol;');await a.execute("import type {token as first} from './decl.js'; type Original=typeof first; let before!:Original;");const second=await a.execute("import type {token as later} from './decl.js'; let current!:typeof later; const checked:Original=current;",'second.ts');assert.equal(second.kind,'returned');assert.equal(a.state.value(a.state.find('checked')),undefined);
});
