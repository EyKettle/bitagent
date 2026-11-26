import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCompilerSession,beginPublication} from '@bitagent/core/host';
import {createState,StateError} from '@bitagent/core/state';
import {CompilationError} from '@bitagent/core/compiler';
import {application} from './fixtures/application.mjs';

test('State retains original bindings, current aliases, snapshots and exact removal',async t=>{
 const a=await application(t);
 const run=await a.execute('let object = {n:1}; const alias = object; const primitive=1; interface Pure {n:number}; let missing: undefined; object');
 assert.equal(run.kind,'returned');assert.equal(a.value('object'),run.value);assert.deepEqual(a.state.aliases(run.value).map(d=>d.spec.name),['object','alias']);assert.equal(a.value('missing'),undefined);
 assert.throws(()=>a.value('Pure'),e=>e instanceof StateError&&e.kind==='missing-value');
 const snapshot=a.state.snapshot(),old=a.state.find('object');assert.ok(Object.isFrozen(snapshot.definitions));
 await a.execute('object = {n:2}; object.n++');assert.equal(a.state.revision,snapshot.revision);assert.equal(a.value('object').n,3);assert.deepEqual(a.state.aliases(run.value).map(d=>d.spec.name),['alias']);
 const change=a.state.remove(old,old);assert.equal(change.removed.length,1);assert.throws(()=>a.state.remove(old),e=>e.kind==='stale');
 assert.throws(()=>a.state.remove({...a.state.find('alias')}),TypeError);assert.throws(()=>a.state.aliases(1),TypeError);
 await a.execute('const object = {n:4};');assert.notEqual(a.state.find('object'),old);assert.throws(()=>a.state.value(old),e=>e.kind==='stale');
 const b=await application(t);await b.execute('const other=1;');assert.throws(()=>a.state.remove(a.state.find('alias'),b.state.find('other')),e=>e.kind==='foreign');assert.ok(a.state.find('alias'));
});

test('publication follows native hoisting, TDZ, partial destructuring and original thrown undefined',async t=>{
 const a=await application(t);
 const result=await a.execute('interface Before {n:number}; throw undefined; var hoisted; function earlier(){return 7}; const absent=1;');
 assert.equal(result.kind,'threw');assert.equal(result.error,undefined);assert.deepEqual(result.change.added.map(d=>d.spec.name),['Before','hoisted','earlier']);assert.equal(a.value('hoisted'),undefined);assert.equal(a.value('earlier')(),7);assert.equal(a.state.find('absent'),undefined);
 const partial=await a.execute('const [first, second = (()=>{throw 5})()] = [1];');assert.equal(partial.kind,'threw');assert.equal(partial.error,5);assert.equal(a.value('first'),1);assert.equal(a.state.find('second'),undefined);
});

test('prepared identities are once-only, stale, foreign and discarded before effects',async t=>{
 const a=await application(t),b=await application(t);
 const p=await a.prepare('const value=1; value');assert.equal(p.kind,'ready');
 assert.throws(()=>b.session.execute(p.input),e=>e instanceof CompilationError&&e.kind==='foreign');assert.throws(()=>a.session.execute({...p.input}),TypeError);
 await a.execute('const another=2;');assert.throws(()=>a.session.execute(p.input),e=>e.kind==='stale');assert.equal(a.session.discard(p.input),true);assert.equal(a.session.discard(p.input),false);
 const q=await a.prepare('throw 3');const failed=a.session.execute(q.input);assert.equal(failed.kind,'threw');assert.equal(q.input.state,'used');assert.throws(()=>a.session.execute(q.input),e=>e.kind==='used');
 assert.throws(()=>createCompilerSession({state:a.state,root:b.root,compiler:a.compiler}),e=>e.kind==='configuration');
 assert.throws(()=>beginPublication(a.state,{}),TypeError);assert.throws(()=>createCompilerSession({state:createState(),root:{...a.root},compiler:a.compiler}),TypeError);
});

test('prepared work belongs to its caller and Session borrows root and compiler',async t=>{
 const a=await application(t);
 assert.throws(()=>a.session.prepare(a.input('1')),TypeError);
 const q=await a.prepare('const final=3;');await a.session.close();assert.equal(a.compiler.state,'open');assert.equal(a.root.state,'open');assert.equal(q.input.state,'discarded');assert.throws(()=>a.session.execute(q.input),e=>e.kind==='closed');
 const next=createCompilerSession({state:a.state,root:a.root,compiler:a.compiler});const p=await (async()=>{const {waitForJob}=await import('@bitagent/core/host');return waitForJob(a.root.run(()=>next.prepare(a.input('1'))));})();assert.equal(p.state,'finished');await next.close();
});
