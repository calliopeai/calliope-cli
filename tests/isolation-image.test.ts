import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertLocalIsolationImage} from '../src/isolation/process.js';
let root:string;
const image='sha256:'+'a'.repeat(64);
beforeEach(()=>{
  root=fs.mkdtempSync(join(tmpdir(),'calliope-image-test-'));
  fs.writeFileSync(join(root,'docker'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),root=${JSON.stringify(root)},args=process.argv.slice(2);
fs.writeFileSync(path.join(root,'request.json'),JSON.stringify({args,env:process.env}));
const mode=fs.existsSync(path.join(root,'mode'))?fs.readFileSync(path.join(root,'mode'),'utf8'):'pass';
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='fail'){process.stderr.write('private sentinel');process.exitCode=1;}
else if(mode==='large')process.stdout.write('x'.repeat(10000));
else process.stdout.write(args.at(-1)+(mode==='wrong-os'?' windows':' linux')+'\\n');
`,{mode:0o700});
  vi.stubEnv('PATH',root+':'+process.env.PATH);vi.stubEnv('PROVIDER_SECRET_SENTINEL','must-not-propagate');vi.stubEnv('DOCKER_HOST','tcp://untrusted.invalid');
});
afterEach(()=>{vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
it('checks the exact local Linux image without pulls, execution, inherited keys or remote contexts',async()=>{
  await assertLocalIsolationImage(image);const request=JSON.parse(fs.readFileSync(join(root,'request.json'),'utf8'));
  expect(request.args).toEqual(['--host','unix:///var/run/docker.sock','image','inspect','--format','{{.Id}} {{.Os}}',image]);expect(Object.keys(request.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING')).toEqual(['PATH']);
});
it('fails safely on unavailable images, unsupported OS, output overflow or a missing Docker binary',async()=>{
  for(const mode of ['fail','wrong-os','large']){fs.writeFileSync(join(root,'mode'),mode);await expect(assertLocalIsolationImage(image)).rejects.toThrow('pinned verification image is unavailable');}
  vi.stubEnv('PATH',join(root,'missing'));await expect(assertLocalIsolationImage(image)).rejects.toThrow('will not pull');
  await expect(assertLocalIsolationImage('node:latest')).rejects.toThrow('pinned local image');
});
it('cancels image inspection, including pre-aborted calls, and bounds unresponsive local admission',async()=>{
  fs.writeFileSync(join(root,'mode'),'hang');const controller=new AbortController(),pending=assertLocalIsolationImage(image,controller.signal);setTimeout(()=>controller.abort(),100);
  await expect(pending).rejects.toThrow();await expect(assertLocalIsolationImage(image,AbortSignal.abort())).rejects.toThrow();
  await expect(assertLocalIsolationImage(image)).rejects.toThrow('unavailable');
},10000);
