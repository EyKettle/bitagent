import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('public module versions reference the matching adopted source versions',async t=>{
 const a=await application(t);await a.write('record.ts','export const value=1;');const prepared=await a.prepare("import {value} from './record.js'; value");assert.equal(prepared.kind,'ready');const compiled=prepared.input.compilation;
 for(const module of compiled.modules){const source=compiled.sources.find(source=>source.url===module.url);assert.ok(source,module.url);assert.equal(module.sourceVersion,source.version);}
});
