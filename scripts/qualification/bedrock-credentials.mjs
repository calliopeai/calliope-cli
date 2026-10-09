import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {qualifyBedrock} from '../release/bedrock-smoke.mjs';

test('built Node CLI resolves workload credentials and cancels helper processes',{timeout:15000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'calliope-bedrock-package-'));
  try {await qualifyBedrock(process.execPath,[fileURLToPath(new URL('../../dist/bin.js',import.meta.url))],root);}
  finally {rmSync(root,{recursive:true,force:true});}
});
