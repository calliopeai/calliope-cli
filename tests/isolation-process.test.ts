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
const fault=fs.existsSync(path.join(root,'fault.json'))?JSON.parse(fs.readFileSync(path.join(root,'fault.json'))):{};
fs.appendFileSync(path.join(root,'operations.jsonl'),JSON.stringify({op,args,env:process.env})+'\\n');
const absent=kind=>{process.stderr.write('Error response from daemon: No such '+kind+': '+name+'\\n');process.exitCode=1;};
const hang=()=>{process.on('SIGTERM',()=>{});setInterval(()=>{},1000);};
if(op==='create'){fs.writeFileSync(file,JSON.stringify({args,env:process.env}));if(fault.create==='hang')hang();else if(fault.create==='error')process.exitCode=125;else process.stdout.write('synthetic-container-id');}
else if(op==='rm'){
 if(fault.remove==='hang')hang();else if(fault.remove==='absent')absent('container');
 else process.exitCode=fault.remove==='error'||fs.existsSync(path.join(root,'fail-cleanup'))?1:0;
}
else if(op==='container'){
 if(fault.inspect==='absent'||fault.inspect==='object')absent(fault.inspect==='object'?'object':'container');
 else if(fault.inspect==='hang')hang();
 else if(fault.inspect==='present')process.stdout.write('b'.repeat(64));
 else if(fault.inspect==='wrong'){process.stderr.write('Error response from daemon: No such container: unrelated');process.exitCode=1;}
 else if(fault.inspect==='spoof'){process.stderr.write('Cannot connect: No such container: '+name);process.exitCode=1;}
 else if(fault.inspect==='overflow'){process.stderr.write('Error response from daemon: No such container: '+name+' '.repeat(5000));process.exitCode=1;}
 else if(fault.inspect==='stdout'){absent('container');process.stdout.write('unexpected');}
 else if(fault.inspect==='malformed')process.stdout.write('not-an-id');
 else {process.stderr.write('Cannot connect to the Docker daemon');process.exitCode=1;}
}
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
const fault=(value:Record<string,string>)=>fs.writeFileSync(join(root,'fault.json'),JSON.stringify(value));
const operations=()=>fs.readFileSync(join(root,'operations.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
it('uses pinned images, read-only grants and bounded resources without inherited credentials',async()=>{
  const result=await run('pass');expect(result).toMatchObject({version:1,kind:'isolated-command',exitCode:0,outcome:'passed',stdout:'passed',cleanupConfirmed:true,truncated:false});
  const recorded=JSON.parse(fs.readFileSync(join(root,result.container+'.json'),'utf8'));
  expect(recorded.args).toContain('--network=none');expect(recorded.args).toContain('--read-only');expect(recorded.args).toContain('--pids-limit=64');expect(recorded.args).toContain('--pull=never');
  expect(recorded.args).toContain(`type=bind,source=${root},target=/project,readonly`);expect(recorded.env.PROVIDER_SECRET_SENTINEL).toBeUndefined();expect(Object.keys(recorded.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING')).toEqual(['PATH']);
  expect(result.cleanup).toEqual({version:1,removal:{outcome:'removed',exitCode:0}});expect(operations().map(x=>x.op)).toEqual(['create','start','rm']);
});
it.each(['absent','object'])('confirms %s after a failed removal without rerunning the command',async inspect=>{
  fault({remove:'error',inspect});const result=await run('fail');
  expect(result).toMatchObject({outcome:'failed',exitCode:2,cleanupConfirmed:true,cleanup:{version:1,removal:{outcome:'error',exitCode:1},verification:{outcome:'absent',exitCode:1}}});
  const calls=operations();expect(calls.map(x=>x.op)).toEqual(['create','start','rm','container']);expect(calls[3].args).toEqual(['--host','unix:///var/run/docker.sock','container','inspect','--format','{{.Id}}',result.container]);
  expect(calls.every(x=>x.env.PROVIDER_SECRET_SENTINEL===undefined)).toBe(true);expect(result.stderr).toBe('assertion failed');
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});
it.each(['present','wrong','spoof','overflow','stdout','malformed','daemon'])('keeps %s inspection unconfirmed',async inspect=>{
  fault({remove:'error',inspect});const result=await run('pass');expect(result).toMatchObject({outcome:'unavailable',exitCode:0,cleanupConfirmed:false,cleanup:{verification:{outcome:inspect==='present'?'present':'error'}}});
  expect(operations().map(x=>x.op)).toEqual(['create','start','rm','container']);expect(result.stderr).toBe('');
});
it('bounds a lost removal acknowledgement and confirms absence afterward',async()=>{
  fault({remove:'hang',inspect:'absent'});const result=await run('fail');expect(result).toMatchObject({outcome:'failed',exitCode:2,cleanupConfirmed:true,cleanup:{removal:{outcome:'timeout',exitCode:null},verification:{outcome:'absent',exitCode:1}}});
  expect(operations().map(x=>x.op)).toEqual(['create','start','rm','container']);
},12000);
it('bounds an unavailable absence probe and retains its uncertainty',async()=>{
  fault({remove:'error',inspect:'hang'});expect(await run('pass')).toMatchObject({outcome:'unavailable',cleanupConfirmed:false,cleanup:{verification:{outcome:'timeout',exitCode:null}}});
},8000);
it('does not inspect after acknowledged removal or unconfirmed creation',async()=>{
  fault({remove:'absent'});expect(await run('fail')).toMatchObject({cleanupConfirmed:true,cleanup:{removal:{outcome:'absent',exitCode:1}}});expect(operations().some(x=>x.op==='container')).toBe(false);
  fault({create:'error',remove:'error',inspect:'absent'});expect(await run('pass')).toMatchObject({outcome:'unavailable',cleanupConfirmed:false,cleanup:{removal:{outcome:'error'}}});expect(operations().some(x=>x.op==='container')).toBe(false);
});
it('preserves cancellation and timeout after confirmed creation and uncertain cleanup',async()=>{
  fault({remove:'error',inspect:'absent'});const controller=new AbortController(),pending=run('hang',controller.signal);
  for(let n=0;n<150;n++){if(fs.existsSync(join(root,'operations.jsonl'))&&operations().some(x=>x.op==='start'))break;await new Promise(resolve=>setTimeout(resolve,10));}
  expect(operations().some(x=>x.op==='start')).toBe(true);controller.abort();expect(await pending).toMatchObject({outcome:'cancelled',exitCode:130,cleanupConfirmed:true,cleanup:{verification:{outcome:'absent'}}});
  expect(await run('hang',undefined,500)).toMatchObject({outcome:'timeout',exitCode:124,cleanupConfirmed:true});
});
it('does not confirm absence when cancellation interrupts creation',async()=>{
  fault({create:'hang',remove:'absent',inspect:'absent'});expect(await run('pass',undefined,150)).toMatchObject({outcome:'timeout',exitCode:124,cleanupConfirmed:false});
  expect(operations().every(x=>x.op==='create'||x.op==='rm')).toBe(true);
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
