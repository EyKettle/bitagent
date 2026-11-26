import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

test('batch declaration notifications retain real values and failed destructuring publishes only initialized bindings',async t=>{
 const a=await application(t);const first=await a.execute(Array.from({length:1000},(_,i)=>`const value${i}=${i};`).join('\n'));assert.equal(first.kind,'returned');assert.equal(a.state.snapshot().definitions.length,1000);assert.equal(a.value('value0'),0);assert.equal(a.value('value999'),999);const second=await a.execute('function fail():never{throw undefined}; const [early,later=fail()]=[42]; const neverEntered=3;','partial.ts');assert.equal(second.kind,'threw');assert.equal(second.error,undefined);assert.equal(a.value('early'),42);assert.equal(a.state.find('later'),undefined);assert.equal(a.state.find('neverEntered'),undefined);assert.equal(typeof a.value('fail'),'function');
});
