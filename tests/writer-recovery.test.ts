import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {recoverDeadWriterLock} from '../src/execution/index.js';
import {coordinatorRun} from './helpers/coordinator-run.js';
import {simulateWindowsDirectoryFsyncDenial} from './helpers/windows-fsync.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-writer-recovery-')));fs.chmodSync(root,0o700);});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
function dead(file:string){const child=spawnSync(process.execPath,['--input-type=module','-e','import fs from "node:fs"; fs.writeFileSync(process.argv[1],String(process.pid),{mode:0o600});',file]);expect(child.status).toBe(0);return fs.readFileSync(file,'utf8');}
it('reclaims a confirmed exited writer once and retains the inode as recovery evidence',()=>{
  const file=join(root,'writer.lock'),pid=dead(file),before=fs.statSync(file);expect(recoverDeadWriterLock(file)).toBe(true);expect(fs.existsSync(file)).toBe(false);
  const claim=join(root,'lock-recovery',fs.readdirSync(join(root,'lock-recovery'))[0]!);expect(fs.readFileSync(claim,'utf8')).toBe(pid);expect(fs.statSync(claim).ino).toBe(before.ino);expect(recoverDeadWriterLock(file)).toBe(false);
  fs.writeFileSync(file,String(process.pid),{mode:0o600});expect(recoverDeadWriterLock(file)).toBe(false);expect(fs.readFileSync(file,'utf8')).toBe(String(process.pid));
});
it('fails closed for live, malformed, public, symlink and ambiguous locks and bounded recovery history',()=>{
  const file=join(root,'writer.lock');for(const value of ['', 'abc', '0', '2147483648', String(process.pid)]){fs.writeFileSync(file,value,{mode:0o600});expect(recoverDeadWriterLock(file)).toBe(false);}
  dead(file);fs.chmodSync(file,0o644);expect(recoverDeadWriterLock(file)).toBe(false);fs.chmodSync(file,0o600);
  const probe=vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('Denied'),{code:'EPERM'});});expect(recoverDeadWriterLock(file)).toBe(false);probe.mockRestore();
  fs.renameSync(file,join(root,'source'));fs.symlinkSync(join(root,'source'),file);expect(recoverDeadWriterLock(file)).toBe(false);fs.unlinkSync(file);fs.renameSync(join(root,'source'),file);
  fs.mkdirSync(join(root,'lock-recovery'),{mode:0o700});for(let n=0;n<64;n++)fs.writeFileSync(join(root,'lock-recovery',String(n)),'');expect(recoverDeadWriterLock(file)).toBe(false);expect(fs.existsSync(file)).toBe(true);
});
it('preserves interrupted reclaim claims and resumes journals after a real writer process exits',async()=>{
  const run=await coordinatorRun(root),writer=join(run.store.root,'writer.lock');dead(writer);const before=run.store.read();await run.store.append({type:'agent_stop',agentId:'a'});expect(run.store.read().header).toEqual(before.header);expect(run.store.read().state.stoppedAgents).toEqual(['a']);
  dead(join(run.store.root,'owner.lock'));const lease=run.store.acquire();lease.check();lease.release();
  const file=join(root,'writer.lock');dead(file);const stat=fs.statSync(file),recovery=join(root,'lock-recovery');fs.mkdirSync(recovery,{mode:0o700});fs.linkSync(file,join(recovery,`writer.lock-${stat.dev}-${stat.ino}`));expect(recoverDeadWriterLock(file)).toBe(false);expect(fs.existsSync(file)).toBe(true);
});
it('reclaims a confirmed exited writer on Windows, where both directories cannot be fsynced (#388)',()=>{
  const restore=simulateWindowsDirectoryFsyncDenial();
  try{
    const file=join(root,'writer.lock');dead(file);
    expect(recoverDeadWriterLock(file)).toBe(true);expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(join(root,'lock-recovery'))).toHaveLength(1);
  }finally{restore();}
});
