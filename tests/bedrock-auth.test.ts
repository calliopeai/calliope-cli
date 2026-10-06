import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {existsSync,readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as config from '../src/config.js';
import {resolveBedrockCredentials} from '../src/providers/bedrock-auth.js';
import {chatBedrock,hasAWSCredentials} from '../src/providers/bedrock.js';

let directory:string,server:Server|undefined,saved:Record<string,string|undefined>;
const awsKey=(key:string)=>key.startsWith('AWS_')||key.startsWith('BEDROCK_');
const shellPath=(value:string)=>{
  if(process.platform==='win32'){
    if(/["%\r\n]/.test(value))throw new Error('Unsupported fixture path');
    return '"'+value+'"';
  }
  return "'"+value.replaceAll("'","'\\''")+"'";
};

beforeEach(()=>{
  saved=Object.fromEntries(Object.entries(process.env).filter(([key])=>awsKey(key)));
  for(const key of Object.keys(process.env))if(awsKey(key))delete process.env[key];
  directory=mkdtempSync(join(tmpdir(),'calliope-aws-'));
  process.env.AWS_CONFIG_FILE=join(directory,'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE=join(directory,'credentials');
  process.env.AWS_EC2_METADATA_DISABLED='true';
  writeFileSync(process.env.AWS_CONFIG_FILE,'');
  writeFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE,'');
  config.resetConfig();
});
afterEach(async()=>{
  vi.unstubAllGlobals();
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}
  config.resetConfig();
  for(const key of Object.keys(process.env))if(awsKey(key))delete process.env[key];
  Object.assign(process.env,saved);
  rmSync(directory,{recursive:true,force:true});
});
async function listen(handler:Parameters<typeof createServer>[0]) {
  server=createServer(handler);
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  if(!address||typeof address==='string')throw new Error('No fixture address');
  return `http://127.0.0.1:${address.port}`;
}
function credentials(key:string,expiration=Date.now()+3600000){
  return {AccessKeyId:key,SecretAccessKey:'fixture-secret',Token:'fixture-session-'+key,Expiration:new Date(expiration).toISOString()};
}

describe('native AWS credential chain',()=>{
  it('signs actual Converse HTTP requests with fresh ECS task credentials',async()=>{
    let generation=0;
    const signed:string[]=[],tokens:string[]=[],metadataTokens:string[]=[];
    const endpoint=await listen((request,response)=>{
      response.setHeader('Content-Type','application/json');
      if(request.url==='/credentials'){metadataTokens.push(String(request.headers.authorization));response.end(JSON.stringify(credentials('TASK-'+(++generation))));}
      else {
        signed.push(String(request.headers.authorization));tokens.push(String(request.headers['x-amz-security-token']));
        request.resume();
        response.end(JSON.stringify({output:{message:{content:[{text:'fixture complete'}]}},stopReason:'end_turn',usage:{inputTokens:3,outputTokens:2}}));
      }
    });
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=endpoint+'/credentials';
    process.env.AWS_REGION='us-west-2';
    const transport=globalThis.fetch;
    vi.stubGlobal('fetch',(url:string,init:RequestInit)=>transport(endpoint+new URL(url).pathname,init));
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE=join(directory,'pod-token');
    for(let i=0;i<2;i++){
      writeFileSync(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE,'pod-token-'+i);
      expect((await chatBedrock([{role:'user',content:'fixture'}],[],'fixture-model')).content).toBe('fixture complete');
    }
    expect(metadataTokens).toEqual(['pod-token-0','pod-token-1']);
    expect(generation).toBe(2);
    expect(signed[0]).toContain('Credential=TASK-1/');expect(signed[1]).toContain('Credential=TASK-2/');
    expect(signed.every(value=>value.includes('/us-west-2/bedrock/aws4_request'))).toBe(true);
    expect(tokens).toEqual(['fixture-session-TASK-1','fixture-session-TASK-2']);
  });

  it('uses scoped shared files and sees rotated named-profile credentials',async()=>{
    config.setProviderCred('bedrock',{profile:'reviewed'});
    for(const key of ['PROFILE-A','PROFILE-B']){
      writeFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE!,`[reviewed]\naws_access_key_id=${key}\naws_secret_access_key=fixture-secret\n`);
      expect((await resolveBedrockCredentials()).accessKeyId).toBe(key);
    }
  });

  it('detects and resolves a default profile supplied only by scoped config',async()=>{
    rmSync(process.env.AWS_SHARED_CREDENTIALS_FILE!);
    writeFileSync(process.env.AWS_CONFIG_FILE!,'[default]\naws_access_key_id=CONFIG-ONLY\naws_secret_access_key=fixture-secret\n');
    expect(hasAWSCredentials()).toBe(true);
    expect((await resolveBedrockCredentials()).accessKeyId).toBe('CONFIG-ONLY');
  });

  it('does not fall back from a missing selected profile to ambient credentials',async()=>{
    config.setProviderCred('bedrock',{profile:'missing'});
    process.env.AWS_ACCESS_KEY_ID='AMBIENT';process.env.AWS_SECRET_ACCESS_KEY='ambient-secret';
    await expect(resolveBedrockCredentials()).rejects.toThrow('AWS credentials not found');
  });

  it('exchanges a rotating web-identity token through native STS',async()=>{
    const tokens:string[]=[];
    const endpoint=await listen((request,response)=>{
      let body='';request.on('data',chunk=>body+=chunk);
      request.on('end',()=>{
        const values=new URLSearchParams(body);tokens.push(values.get('WebIdentityToken')||'');
        response.setHeader('Content-Type','text/xml');
        response.end(`<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>WEB-${tokens.length}</AccessKeyId><SecretAccessKey>fixture-secret</SecretAccessKey><SessionToken>fixture-session</SessionToken><Expiration>${new Date(Date.now()+3600000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
      });
    });
    process.env.AWS_ENDPOINT_URL_STS=endpoint;
    process.env.AWS_REGION='us-west-2';
    process.env.AWS_ROLE_ARN='arn:aws:iam::111122223333:role/fixture';
    process.env.AWS_ROLE_SESSION_NAME='fixture';
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE=join(directory,'identity-token');
    for(const [i,token] of ['first-token','renewed-token'].entries()){
      writeFileSync(process.env.AWS_WEB_IDENTITY_TOKEN_FILE,token);
      expect((await resolveBedrockCredentials()).accessKeyId).toBe(`WEB-${i+1}`);
    }
    expect(tokens).toEqual(['first-token','renewed-token']);
  });

  it('assumes a selected role using process credentials from its source profile',async()=>{
    const requests:{action:string|null;authorization:string}[]=[];
    process.env.AWS_ENDPOINT_URL_STS=await listen((request,response)=>{
      let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
        requests.push({action:new URLSearchParams(body).get('Action'),authorization:String(request.headers.authorization)});
        response.setHeader('Content-Type','text/xml');
        response.end(`<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASSUMED</AccessKeyId><SecretAccessKey>fixture-secret</SecretAccessKey><SessionToken>role-session</SessionToken><Expiration>${new Date(Date.now()+3600000).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`);
      });
    });
    const helper=join(directory,'source.cjs');
    writeFileSync(helper,`console.log(${JSON.stringify(JSON.stringify({Version:1,AccessKeyId:'SOURCE',SecretAccessKey:'fixture-source-secret'}))})`);
    writeFileSync(process.env.AWS_CONFIG_FILE!,`[profile selected]\nrole_arn=arn:aws:iam::111122223333:role/fixture\nsource_profile=source\n[profile source]\ncredential_process=${shellPath(process.execPath)} ${shellPath(helper)}\n`);
    config.setProviderCred('bedrock',{profile:'selected',region:'us-west-2'});
    expect(await resolveBedrockCredentials()).toMatchObject({accessKeyId:'ASSUMED',sessionToken:'role-session'});
    expect(requests).toHaveLength(1);expect(requests[0]!.action).toBe('AssumeRole');
    expect(requests[0]!.authorization).toContain('Credential=SOURCE/');
  });

  it('refuses expired metadata',async()=>{
    const endpoint=await listen((_,response)=>response.end(JSON.stringify(credentials('EXPIRED',Date.now()-1000))));
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=endpoint+'/credentials';
    await expect(resolveBedrockCredentials()).rejects.toThrow('AWS credentials not found or expired');
  });

  it('detects stored profiles and native workload sources in provider configuration',()=>{
    expect(config.getConfiguredProviders()).not.toContain('bedrock');
    config.setProviderCred('bedrock',{profile:'selected'});
    expect(config.getConfiguredProviders()).toContain('bedrock');
    config.resetConfig();
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI='http://127.0.0.1/credentials';
    expect(config.getConfiguredProviders()).toContain('bedrock');
    delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE=join(directory,'token');
    expect(config.getConfiguredProviders()).not.toContain('bedrock');
    process.env.AWS_ROLE_ARN='arn:aws:iam::111122223333:role/fixture';
    expect(config.getConfiguredProviders()).toContain('bedrock');
  });

  it('executes credential_process afresh and hides helper output on failure',async()=>{
    const helper=join(directory,'helper.cjs');
    process.env.AWS_PROFILE='process';
    writeFileSync(process.env.AWS_CONFIG_FILE!,`[profile process]\ncredential_process = ${shellPath(process.execPath)} ${shellPath(helper)}\n`);
    for(const key of ['PROCESS-A','PROCESS-B']){
      writeFileSync(helper,`console.log(${JSON.stringify(JSON.stringify({Version:1,AccessKeyId:key,SecretAccessKey:'fixture-secret',SessionToken:'session'}))})`);
      expect((await resolveBedrockCredentials()).accessKeyId).toBe(key);
    }
    writeFileSync(helper,'console.error("private-credential-secret");process.exit(1)');
    await expect(resolveBedrockCredentials()).rejects.toThrow(/^AWS credentials not found or expired for the selected Bedrock identity\./);
  });

  it.skipIf(process.platform==='win32')('times out and removes a credential_process that ignores TERM',async()=>{
    const helper=join(directory,'hang.cjs'),pidFile=join(directory,'pid');
    writeFileSync(helper,`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`);
    process.env.AWS_PROFILE='process';
    writeFileSync(process.env.AWS_CONFIG_FILE!,`[profile process]\ncredential_process = ${shellPath(process.execPath)} ${shellPath(helper)}\n`);
    const pending=resolveBedrockCredentials();
    const outcome=expect(pending).rejects.toThrow('AWS credentials not found or expired');
    try {
      await vi.waitFor(()=>expect(existsSync(pidFile)).toBe(true),{timeout:3000});
      const pid=Number(readFileSync(pidFile,'utf8'));
      await outcome;
      await vi.waitFor(()=>expect(()=>process.kill(pid,0)).toThrow(),{timeout:1000});
    } finally {
      if(existsSync(pidFile)){try{process.kill(Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}}
      await outcome;
    }
  },15000);

  it('honors cancellation during successful worker cleanup',async()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    const endpoint=await listen((_,response)=>{
      response.end(JSON.stringify(credentials('READY')));
      timer=setTimeout(()=>controller.abort(),100);
    });
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=endpoint+'/credentials';
    try {await expect(resolveBedrockCredentials(controller.signal)).rejects.toMatchObject({name:'AbortError'});}
    finally {if(timer)clearTimeout(timer);}
  });

  it('cancels credential waiting before any Converse request',async()=>{
    let received!:()=>void;
    const ready=new Promise<void>(resolve=>received=resolve);
    const endpoint=await listen(()=>received());
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI=endpoint+'/credentials';
    const controller=new AbortController(),transport=vi.fn();
    vi.stubGlobal('fetch',transport);
    const pending=chatBedrock([{role:'user',content:'fixture'}],[],'fixture-model',undefined,controller.signal);
    const outcome=expect(pending).rejects.toMatchObject({name:'AbortError'});
    await ready;controller.abort();await outcome;
    expect(transport).not.toHaveBeenCalled();
  });
});
