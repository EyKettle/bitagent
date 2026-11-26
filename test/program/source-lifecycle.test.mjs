import assert from 'node:assert/strict';
import {test} from 'node:test';
import {waitForJob,createCompilerSession} from '@bitagent/core/host';
import {application} from './fixtures/application.mjs';

test('closing the Compiler preserves fixed prepared execution but rejects new work',async t=>{
 const a=await application(t);const prepared=await a.prepare('const retained=4; retained');const closing=a.compiler.close('first');assert.equal(a.compiler.close('replacement'),closing);await closing;assert.equal(a.compiler.state,'closed');const execution=a.session.execute(prepared.input);assert.equal(execution.kind,'returned');assert.equal(execution.value,4);assert.throws(()=>a.root.run(()=>a.session.prepare(a.input('1'))),error=>error.kind==='closed');assert.equal(a.state.find('retained').spec.type.display,'4');
});
test('file compilation captures source once and syntax/type failures have real UTF-16 spans',async t=>{
 const a=await application(t);await a.write('read.ts','const value=1; value');const outcome=await waitForJob(a.root.run(()=>a.session.prepare({kind:'file',url:new URL('read.ts',a.baseURL)})));assert.equal(outcome.state,'finished');assert.equal(outcome.value.kind,'ready');await a.write('read.ts','const value=9; value');assert.equal(a.session.execute(outcome.value.input).value,1);
 const missing=await waitForJob(a.root.run(()=>a.compiler.compile({kind:'file',url:new URL('missing.ts',a.baseURL)},a.state.snapshot())));assert.equal(missing.state,'failed');assert.equal(missing.error.code,'ENOENT');
 const before=a.state.revision;const invalid=await a.prepare('const text:string = 3;');assert.equal(invalid.kind,'diagnostics');const diagnostic=invalid.diagnostics.find(d=>d.code==='ts:2322');assert.ok(diagnostic);assert.equal(diagnostic.span.start,6);assert.equal(diagnostic.span.url,a.input('').url.href);assert.equal(a.state.revision,before);assert.ok(Object.isFrozen(invalid.diagnostics));
 const dynamic=await a.prepare("const load=()=>import('./read.js');");assert.equal(dynamic.kind,'diagnostics');assert.ok(dynamic.diagnostics.some(d=>d.code==='core:dynamic-import'));
});
test('same-State sessions share services and independently discard their prepared inputs',async t=>{
 const a=await application(t);const second=createCompilerSession({state:a.state,root:a.root,compiler:a.compiler});t.after(()=>second.close());const first=await a.prepare('const one=1;');const other=await waitForJob(a.root.run(()=>second.prepare(a.input('const two=2;'))));assert.equal(other.state,'finished');await second.close();assert.equal(other.value.input.state,'discarded');assert.equal(first.input.state,'ready');assert.equal(a.session.execute(first.input).kind,'returned');assert.equal(a.root.state,'open');assert.equal(a.compiler.state,'open');
});
