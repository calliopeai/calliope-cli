import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectSpendLedger} from '../src/execution/project-spend.js';

let root:string,file:string;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-project-read-')));file=join(root,'budget.json');});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});

it('waits for an initializing writer instead of reading its marker as lost history',()=>{
  fs.writeFileSync(file+'.lock',String(process.pid),{mode:0o600});
  fs.writeFileSync(file+'.initialized','version=2',{mode:0o600});
  const pause=vi.spyOn(Atomics,'wait').mockImplementation(()=>{
    fs.writeFileSync(file,JSON.stringify({version:2,events:[],spentUsd:0,updatedAt:new Date(0).toISOString()}),{mode:0o600});
    fs.unlinkSync(file+'.lock');return 'timed-out';
  });
  expect(new ProjectSpendLedger(file).read().spentUsd).toBe(0);
  expect(pause).toHaveBeenCalledTimes(1);
});

it('retains a writer lock when its bounded read wait expires',()=>{
  fs.writeFileSync(file+'.lock','unresolved-writer',{mode:0o600});
  vi.spyOn(Atomics,'wait').mockReturnValue('timed-out');
  expect(()=>new ProjectSpendLedger(file).read()).toThrow('another writer');
  expect(fs.readFileSync(file+'.lock','utf8')).toBe('unresolved-writer');
  expect(fs.existsSync(file)).toBe(false);
});

it('never resets a missing journal after the initializer has stopped',()=>{
  fs.writeFileSync(file+'.initialized','version=2',{mode:0o600});
  expect(()=>new ProjectSpendLedger(file).read()).toThrow('damaged');
  expect(fs.existsSync(file)).toBe(false);
});

it('keeps corrupt committed history fail-closed and preserves existing charges',()=>{
  const ledger=new ProjectSpendLedger(file);ledger.charge(0.25);
  expect(ledger.read().spentUsd).toBe(0.25);
  fs.writeFileSync(file,'corrupt',{mode:0o600});
  expect(()=>ledger.read()).toThrow('damaged');
  expect(fs.readFileSync(file,'utf8')).toBe('corrupt');
});
