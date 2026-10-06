/** Real packaged SDK/IPC and public doctor cancellation; no AWS account needed. */
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const shellPath=(value)=>{
  if(process.platform==='win32'){
    if(/["%\r\n]/.test(value))throw new Error('Unsupported fixture path');
    return '"'+value+'"';
  }
  return "'"+value.replaceAll("'","'\\''")+"'";
};

export async function qualifyBedrock(executable, prefix, root) {
  const cwd=join(root,'bedrock');mkdirSync(cwd);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AWS_')&&!key.startsWith('BEDROCK_')));
  Object.assign(env,{HOME:cwd,USERPROFILE:cwd,CALLIOPE_CONFIG_DIR:join(cwd,'config'),
    AWS_CONFIG_FILE:join(cwd,'aws-config'),AWS_SHARED_CREDENTIALS_FILE:join(cwd,'aws-credentials'),AWS_EC2_METADATA_DISABLED:'true'});
  writeFileSync(env.AWS_CONFIG_FILE,'');writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE,'');
  let requests=0;
  const server=createServer((request,response)=>{
    requests++;
    response.setHeader('Content-Type','application/json');
    response.end(JSON.stringify({AccessKeyId:`TASK-${requests}`,SecretAccessKey:'fixture-secret',Token:'fixture-session',Expiration:new Date(Date.now()+3600000).toISOString()}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  env.AWS_CONTAINER_CREDENTIALS_FULL_URI=`http://127.0.0.1:${server.address().port}/credentials`;
  const stop=child=>new Promise(resolve=>{
    if(process.platform==='win32')execFile(join(process.env.SystemRoot,'System32','taskkill.exe'),['/pid',String(child.pid),'/T','/F'],{timeout:2000},()=>resolve());
    else {try{process.kill(-child.pid,'SIGKILL');}catch{}resolve();}
  });
  const worker=async(profile)=>{
    const child=spawn(executable,[...prefix,'--internal-aws-credentials'],{cwd,env,
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc'],serialization:'json'});
    const exited=new Promise(resolve=>child.once('exit',resolve));
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    let timer;
    try {
      const result=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Packaged credential worker timed out')),5000);
        child.once('error',reject);child.once('exit',()=>reject(new Error('Credential worker exited before reply')));
        child.once('message',resolve);child.send({profile,region:'us-west-2'});
      });
      assert.equal(output,'');
      return result;
    } finally {clearTimeout(timer);await stop(child);await exited;}
  };
  try {
    // The internal entry must not silently import credentials from project .env.
    writeFileSync(join(cwd,'.env'),'AWS_ACCESS_KEY_ID=WRONG\nAWS_SECRET_ACCESS_KEY=WRONG\n');
    for(let generation=1;generation<=2;generation++)assert.equal((await worker()).accessKeyId,`TASK-${generation}`);
    assert.equal((await worker('missing')).error,true);
    assert.equal(requests,2);
    writeFileSync(join(cwd,'.env'),'');
    delete env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    const helper=join(cwd,'helper.cjs'),pidFile=join(cwd,'helper-pid');
    writeFileSync(helper,`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
    writeFileSync(env.AWS_CONFIG_FILE,`[profile helper]\ncredential_process = ${shellPath(process.execPath)} ${shellPath(helper)}\n`);
    env.AWS_PROFILE='helper';
    const doctor=spawn(executable,[...prefix,'doctor','provider','bedrock','--probe','--json','--timeout-ms','2500'],{cwd,env,stdio:['ignore','pipe','pipe']});
    let output='',errors='';doctor.stdout.on('data',chunk=>output+=chunk);doctor.stderr.on('data',chunk=>errors+=chunk);
    let timer;
    try {
      const code=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Doctor cancellation timed out')),8000);
        doctor.once('error',reject);doctor.once('exit',resolve);
      });
      assert.equal(code,1,errors);
      assert.equal(JSON.parse(output).providers[0].discovery.status,'timeout');
      assert.ok(existsSync(pidFile),'Native SDK must actually start the configured helper');
      const pid=Number(readFileSync(pidFile,'utf8'));
      let alive=true;
      for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}
      assert.equal(alive,false,'Doctor must remove helper descendants');
    } finally {
      clearTimeout(timer);doctor.kill();
      if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}}
    }
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
