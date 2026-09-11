import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {containerArguments,runIsolatedCommand} from '../src/isolation/process.js';
let root:string;
const image='sha256:'+'a'.repeat(64);
beforeEach(()=>{
  root=fs.mkdtempSync(join(tmpdir(),'calliope-container-test-'));
  fs.writeFileSync(join(root,'docker'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),root=${JSON.stringify(root)};
const op=args[2],name=op==='create'?args[args.indexOf('--name')+1]:args.at(-1),file=path.join(root,name+'.json');
if(op==='create'){fs.writeFileSync(file,JSON.stringify({args,env:process.env}));process.stdout.write('synthetic-container-id');}
else if(op==='rm'){process.exit(fs.existsSync(path.join(root,'fail-cleanup'))?1:0);}
else if(op==='start'){const saved=JSON.parse(fs.readFileSync(file)),argv=saved.args.slice(saved.args.indexOf('--entrypoint')+1),mode=argv[0];
 if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
 else if(mode==='fail'){process.stderr.write('assertion failed');process.exitCode=2;}
 else if(mode==='large')process.stdout.write('x'.repeat(100000));
 else process.stdout.write('passed');}
else process.exitCode=125;
`,{mode:0o700});
  vi.stubEnv('PATH',root+':'+process.env.PATH);vi.stubEnv('PROVIDER_SECRET_SENTINEL','never-pass-to-container-client');
});
afterEach(()=>{vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
const run=(mode:string,signal?:AbortSignal,timeoutMs=3000)=>runIsolatedCommand(image,{artifactId:'check',argv:[mode],timeoutMs},[{source:root,target:'/project'}],signal);
it('uses pinned images, read-only grants and bounded resources without inherited credentials',async()=>{
  const result=await run('pass');expect(result).toMatchObject({version:1,kind:'isolated-command',exitCode:0,outcome:'passed',stdout:'passed',cleanupConfirmed:true,truncated:false});
  const recorded=JSON.parse(fs.readFileSync(join(root,result.container+'.json'),'utf8'));
  expect(recorded.args).toContain('--network=none');expect(recorded.args).toContain('--read-only');expect(recorded.args).toContain('--pids-limit=64');expect(recorded.args).toContain('--pull=never');
  expect(recorded.args).toContain(`type=bind,source=${root},target=/project,readonly`);expect(recorded.env.PROVIDER_SECRET_SENTINEL).toBeUndefined();expect(Object.keys(recorded.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING')).toEqual(['PATH']);
});
it('retains nonzero exits, bounded output and unconfirmed cleanup as distinct outcomes',async()=>{
  expect(await run('fail')).toMatchObject({outcome:'failed',exitCode:2,stderr:'assertion failed'});
  const large=await run('large');expect(large.stdout.length).toBe(65536);expect(large.truncated).toBe(true);
  fs.writeFileSync(join(root,'fail-cleanup'),'');expect(await run('pass')).toMatchObject({outcome:'unavailable',cleanupConfirmed:false});
});
it('cancels the process group and distinguishes cancellation from command timeout',async()=>{
  const controller=new AbortController(),pending=run('hang',controller.signal);setTimeout(()=>controller.abort(),150);
  expect(await pending).toMatchObject({outcome:'cancelled',exitCode:130});
  expect(await run('hang',undefined,150)).toMatchObject({outcome:'timeout',exitCode:124});
  await expect(run('pass',AbortSignal.abort())).rejects.toThrow();
});
it('fails closed when Docker cannot start and rejects unsafe mounts or mutable image names',async()=>{
  vi.stubEnv('PATH',join(root,'missing'));expect(await run('pass')).toMatchObject({outcome:'unavailable',exitCode:125,cleanupConfirmed:false});
  const name='calliope-check-00000000-0000-4000-8000-000000000000';
  expect(()=>containerArguments('node:latest',name,['node'],[])).toThrow(/identity/);
  expect(()=>containerArguments(image,name,[],[])).toThrow();
  expect(()=>containerArguments(image,name,['node'],[{source:root+',rw',target:'/project'}])).toThrow();
});
