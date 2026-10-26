import {afterAll,describe,expect,it,vi} from 'vitest';
const {home}=vi.hoisted(()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  return {home:fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'acp-controls-')))};
});
vi.mock('os',async original=>({...await original<typeof import('node:os')>(),homedir:()=>home}));
import * as fs from 'node:fs';
import {join} from 'node:path';
import {createSession,getSessionDirById} from '../src/storage.js';
import {readAcpControls,saveAcpControls} from '../src/acp/controls.js';
afterAll(()=>fs.rmSync(home,{recursive:true,force:true}));
const fresh=(managed=true)=>{
  const id=createSession(home,{activate:false,prefix:'acp',...(managed?{acpControlsVersion:1 as const}:{})}).id;
  return {id,file:join(getSessionDirById(id)!,'acp-controls.json')};
};
describe('durable ACP controls',()=>{
  it('requires controls for new managed sessions but accepts legacy sessions',()=>{
    const managed=fresh(),legacy=fresh(false);
    expect(()=>readAcpControls(managed.id)).toThrow(/missing/);
    expect(readAcpControls(legacy.id)).toMatchObject({revision:null,mode:'work'});
    expect(()=>readAcpControls('missing-session')).toThrow();
  });
  it('retains a selection, fences stale writes and cleans its private lock',()=>{
    const {id,file}=fresh();
    const first=saveAcpControls(id,{version:1,revision:null,mode:'plan'},true);
    const next=saveAcpControls(id,{...first,selection:{provider:'openai',model:'discovered-model'}});
    expect(readAcpControls(id)).toEqual(next);
    expect(fs.statSync(file).mode&0o077).toBe(0);
    expect(()=>saveAcpControls(id,first)).toThrow(/changed/);
    expect(readAcpControls(id)).toEqual(next);
    expect(fs.existsSync(file+'.lock')).toBe(false);
    fs.writeFileSync(file+'.lock','another writer');
    expect(()=>saveAcpControls(id,next)).toThrow(/another writer/);
    expect(fs.readFileSync(file+'.lock','utf8')).toBe('another writer');
  });
  it('refuses linked state without changing its target',()=>{
    const {id,file}=fresh();const target=join(home,'outside.json');
    fs.writeFileSync(target,'preserve');fs.symlinkSync(target,file);
    expect(()=>readAcpControls(id)).toThrow();
    expect(()=>saveAcpControls(id,{version:1,revision:null,mode:'work'},true)).toThrow();
    expect(fs.readFileSync(target,'utf8')).toBe('preserve');
  });
  it.each(['{','x'.repeat(17000),JSON.stringify({version:2,revision:'x',mode:'work'}),JSON.stringify({version:1,revision:'a'.repeat(36),mode:'work',extra:true}),JSON.stringify({version:1,revision:'a'.repeat(36),mode:'unsafe'})])('refuses malformed retained controls %#',raw=>{
    const {id,file}=fresh();fs.writeFileSync(file,raw);
    expect(()=>readAcpControls(id)).toThrow();
  });
});
