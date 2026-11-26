import assert from 'node:assert/strict';
import {test} from 'node:test';
import {application} from './fixtures/application.mjs';

function libraryDiagnostic(prepared, url, text, name, start = text.indexOf(name)) {
  assert.equal(prepared.kind, 'diagnostics', JSON.stringify(prepared));
  const diagnostic = prepared.diagnostics.find(d => d.code === 'core:shared-library-augmentation' && d.span?.url === url);
  assert.ok(diagnostic, JSON.stringify(prepared.diagnostics));
  assert.equal(diagnostic.phase, 'source');
  assert.equal(diagnostic.severity, 'error');
  assert.deepEqual(diagnostic.span, {url, start, length: name.length});
}

const sharedCases = [
  {name:'Array', declaration:'interface Array<T>{readonly unexpected:string}', initial:'const older=[1,2,3];', intact:'older.join(",")', expected:'1,2,3'},
  {name:'Number', declaration:'interface Number{readonly unexpected:string}', initial:'const older=3;', intact:'older.toFixed(1)', expected:'3.0'},
  {name:'Function', declaration:'interface Function{readonly unexpected:string}', initial:'const older=()=>3;', intact:'older()', expected:3},
];
for (const scenario of sharedCases) test(`shared ${scenario.name} augmentation cannot change an earlier complete Type`, async t => {
  const a = await application(t);
  assert.equal((await a.execute(scenario.initial, 'before.ts')).kind, 'returned');
  const original = a.value('older'), revision = a.state.revision;
  const text = `export {};declare global{${scenario.declaration}}const notPublished:string=older.unexpected;`;
  libraryDiagnostic(await a.prepare(text, 'after.ts'), new URL('after.ts', a.baseURL).href, text, scenario.name);
  assert.equal(a.state.revision, revision);
  assert.equal(a.state.find('notPublished'), undefined);
  assert.equal(a.value('older'), original);
  assert.equal((await a.execute(`const intact=${scenario.intact};`, 'safe.ts')).kind, 'returned');
  assert.equal(a.value('intact'), scenario.expected);
});

test('shared library augmentation in a declaration dependency is diagnosed at its actual source', async t => {
  const a = await application(t);
  const declaration = 'interface Array<T>{readonly unexpected:string}';
  await a.write('extra.d.ts', declaration);
  const text = '/// <reference path="./extra.d.ts"/>\nconst notPublished=1;';
  libraryDiagnostic(await a.prepare(text, 'input.ts'), new URL('extra.d.ts', a.baseURL).href, declaration, 'Array');
  assert.equal(a.state.revision, 0);
  assert.equal(a.state.find('notPublished'), undefined);
});

test('readonly Core augmentation cannot retag an existing runtime contract', async t => {
  const a = await application(t);
  await a.execute("import {contract} from '@bitagent/core';const oldContract=contract<{n:number}>();", 'core-before.ts');
  const original=a.value('oldContract'),revision=a.state.revision;
  const text="import type {Contract} from '@bitagent/core';declare module '@bitagent/core'{interface Contract<T>{readonly ghost:string}}const notPublished:string=oldContract.ghost;";
  libraryDiagnostic(await a.prepare(text, 'core-after.ts'),new URL('core-after.ts',a.baseURL).href,text,'Contract',text.indexOf('interface Contract')+'interface '.length);
  assert.equal(a.state.revision,revision);assert.equal(a.state.find('notPublished'),undefined);assert.equal(a.value('oldContract'),original);
  assert.deepEqual(original.parse({n:1}),{n:1});
  const continued=await a.execute('const intact=oldContract.parse({n:2}).n;','core-safe.ts');assert.equal(continued.kind,'returned');assert.equal(a.value('intact'),2);
});

test('module-local library lookalikes and ordinary user globals remain accepted', async t => {
  const a = await application(t);
  const text = 'export {};interface Array<T>{value:T}interface Number{label:string}interface Contract<T>{local:T}declare global{interface UserData{n:number}}const local:Array<number>={value:2};const number:Number={label:"two"};const user:UserData={n:4};const sum=local.value+number.label.length+user.n;';
  assert.equal((await a.execute(text, 'local.ts')).kind, 'returned');
  assert.equal(a.value('sum'), 9);
  assert.equal((await a.execute('export {};declare global{interface UserData{m:string}}const later:UserData={n:4,m:"new"};', 'user.ts')).kind, 'returned');
  assert.deepEqual(a.value('later'), {n:4,m:'new'});
  const originalType = await a.prepare('const invalid:string=user.m;', 'old-type.ts');
  assert.equal(originalType.kind, 'diagnostics', JSON.stringify(originalType));
  assert.ok(originalType.diagnostics.some(d => d.code === 'ts:2339' && d.message.includes("'m'")), JSON.stringify(originalType.diagnostics));
});
