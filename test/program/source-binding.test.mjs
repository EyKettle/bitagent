import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('module-scope var definitions retain native hoisting even inside control flow',async t=>{
 const a=await application(t);await a.execute('if(false){var absent=1}; for(var index=0;index<2;index++){}; if(true){var visible=3; let hidden=4};');assert.equal(a.value('absent'),undefined);assert.equal(a.value('index'),2);assert.equal(a.value('visible'),3);assert.equal(a.state.find('hidden'),undefined);assert.equal((await a.execute('index + visible')).value,5);
});
test('source import.meta retains the adopted canonical origin through aliases and later calls',async t=>{
 const a=await application(t);await a.write('origin.ts','export const source=import.meta.url; export const locate=()=>import.meta.resolve("./asset.json");');await a.execute('const meta=import.meta; const own=()=>meta.url; import {source,locate} from "./origin.js";');assert.equal(a.value('own')(),a.input('').url.href);assert.equal(a.value('source'),new URL('origin.ts',a.baseURL).href);assert.equal(a.value('locate')(),new URL('asset.json',a.baseURL).href);
});
