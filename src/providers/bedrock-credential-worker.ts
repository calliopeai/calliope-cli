/** Private IPC worker. SDK credential_process helpers belong to this process tree. */
import {execFile} from 'node:child_process';
import {join} from 'node:path';

export async function runBedrockCredentialWorker():Promise<never> {
  if(!process.send)throw new Error('Credential worker requires IPC');
  const stop=()=>{
    if(process.platform==='win32') {
      execFile(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),
        ['/pid',String(process.pid),'/T','/F'],{windowsHide:true,timeout:1000},()=>process.exit(1));
    } else {
      try {process.kill(-process.pid,'SIGKILL');} catch {process.exit(1);}
    }
  };
  // IPC disconnect also covers a parent that dies without running its finally.
  process.once('disconnect',stop);
  setTimeout(stop,12000);
  process.once('message',async(message:unknown)=>{
    try {
      if(!message||typeof message!=='object')throw new Error();
      const {profile,region}=message as {profile?:unknown;region?:unknown};
      if(profile!==undefined&&typeof profile!=='string'||typeof region!=='string')throw new Error();
      const options={...(profile?{profile}:{}),ignoreCache:true,timeout:1000,maxRetries:1,
        clientConfig:{region,maxAttempts:1,requestHandler:{connectionTimeout:1000,requestTimeout:5000}}};
      // Literal lazy imports are bundled into the standalone executable too.
      // Explicit profiles must not fall through to an unrelated ambient identity.
      const provider=profile?(await import('@aws-sdk/credential-provider-ini')).fromIni(options)
        :(await import('@aws-sdk/credential-provider-node')).defaultProvider(options);
      const value=await provider();
      const valid=(field:unknown)=>typeof field==='string'&&field.length>0&&field.length<=32768;
      if(!valid(value.accessKeyId)||!valid(value.secretAccessKey)||
        value.sessionToken!==undefined&&!valid(value.sessionToken)||
        value.expiration&&(!Number.isFinite(value.expiration.getTime())||value.expiration.getTime()<=Date.now()))throw new Error();
      process.send?.({accessKeyId:value.accessKeyId,secretAccessKey:value.secretAccessKey,
        sessionToken:value.sessionToken,expiration:value.expiration?.toISOString()});
    } catch {
      // Never forward SDK errors: credential_process may include secret output.
      process.send?.({error:true});
    }
    // Stay alive until the parent removes the entire process tree, including
    // any helper descendants left behind after successful credential resolution.
  });
  return new Promise<never>(()=>{});
}
