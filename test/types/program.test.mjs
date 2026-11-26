import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {compileConsumer} from './compiler.mjs';

test('all six unit declarations remain portable and enforce authentic handles',()=>{
 const program=compileConsumer(fileURLToPath(new URL('./fixtures/program-consumer.ts',import.meta.url)),process.env.BITAGENT_JOB_TYPES_TARGET);
 const exposed=program.getSourceFiles().filter(source=>!program.isSourceFileDefaultLibrary(source)&&/[/\\]node_modules[/\\](?:effection|@types[/\\]node|typescript)[/\\]/.test(source.fileName));assert.deepEqual(exposed.map(source=>source.fileName),[]);
});
