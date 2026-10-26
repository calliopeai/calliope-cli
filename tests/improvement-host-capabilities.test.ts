import {afterEach,describe,expect,it,vi} from 'vitest';
import {buildIdentity,validBuildMetadata} from '../src/build-identity.js';
import {getVersion} from '../src/version-check.js';
import {runImprovementCommand} from '../src/improvement/index.js';
import {existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';

afterEach(()=>vi.unstubAllGlobals());
const metadata=()=>({version:1,package:{name:'@calliopelabs/cli',version:getVersion()},source:{commit:'a'.repeat(40),dirty:false}});
describe('installed improvement host discovery',()=>{
  it('reports installed interfaces without opening a project or granting authority',async()=>{
    vi.stubGlobal('__CALLIOPE_BUILD_METADATA__',metadata());
    const approve=vi.fn(()=>{throw Error('Unexpected authority request');}),lines:string[]=[];
    expect(await runImprovementCommand(['host-capabilities','--contract-version','1','--json'],{
      cwd:'/nonexistent-host-project',approve,write:line=>lines.push(line)})).toBe(0);
    expect(approve).not.toHaveBeenCalled();expect(lines).toHaveLength(1);
    const result=JSON.parse(lines[0]!);
    expect(result).toMatchObject({version:1,type:'improvement',action:'host-capabilities',localOnly:true,data:{
      version:1,kind:'improvement.host-capabilities',implementation:{artifact:'standalone',metadataStatus:'available',
        package:{name:'@calliopelabs/cli',version:getVersion()},source:{commit:'a'.repeat(40),dirty:false},verification:'external-attestation-required'},
      interfaces:{execution:{version:2,mechanisms:{crossRunLearnedStrategy:false,externalFeedbackImport:false,modelTraining:false}},
        review:{version:1,authority:'request-only-no-execution'},taskOutcome:{version:1,reward:false},sourceChange:{version:1,merge:false,push:false}},
      transport:{discovery:'cli-json',operations:'native-library',cliEnvelopeVersion:1}}});
  });
  it('requires explicit version 2 to discover reviewed feedback without granting learning authority',async()=>{
    const lines:string[]=[],approve=vi.fn();
    expect(await runImprovementCommand(['host-capabilities','--contract-version','2','--json'],{cwd:'/nonexistent-host-project',approve,write:line=>lines.push(line)})).toBe(0);
    expect(JSON.parse(lines[0]!).data).toMatchObject({version:2,interfaces:{taskFeedback:{version:1,operations:['record','inspect','history'],awardsReward:false,changesTaskOutcome:false}}});
    expect(approve).not.toHaveBeenCalled();
    lines.length=0;await runImprovementCommand(['host-capabilities','--json'],{write:line=>lines.push(line)});
    expect(JSON.parse(lines[0]!).data.version).toBe(1);expect(JSON.parse(lines[0]!).data.interfaces.taskFeedback).toBeUndefined();
  });
  it.each(['0','3','','01','latest'])('refuses unsupported contract version %j',async version=>{
    const lines:string[]=[];
    expect(await runImprovementCommand(['host-capabilities',`--contract-version=${version}`,'--json'],{write:line=>lines.push(line)})).toBe(2);
    expect(JSON.parse(lines[0]!).error).toMatchObject({code:'invalid',message:expect.stringContaining('Unsupported')});
  });
  it.each([['--run','foreign'],['--allow-mutations'],['--approve','hash'],['extra']])('rejects execution selectors %j',async(...args)=>{
    const lines:string[]=[];
    expect(await runImprovementCommand(['host-capabilities',...args,'--json'],{write:line=>lines.push(line)})).toBe(2);
    expect(JSON.parse(lines[0]!).error.code).toBe('invalid');
  });
  it('honors cancellation and labels human output with the actual contract versions',async()=>{
    const lines:string[]=[];
    expect(await runImprovementCommand(['host-capabilities','--json'],{signal:AbortSignal.abort(),write:line=>lines.push(line)})).toBe(130);
    expect(JSON.parse(lines[0]!).error.code).toBe('cancelled');
    const human:string[]=[];
    expect(await runImprovementCommand(['host-capabilities'],{write:line=>human.push(line)})).toBe(0);
    expect(human[0]).toContain(`host contract 1 (@calliopelabs/cli@${getVersion()})`);
    await runImprovementCommand(['capabilities'],{write:line=>human.push(line)});
    expect(human[1]).toContain('capabilities (contract 2)');
  });
  it('retains unknown and dirty source state without claiming attestation verification',()=>{
    vi.stubGlobal('__CALLIOPE_BUILD_METADATA__',{...metadata(),source:null});
    expect(buildIdentity()).toMatchObject({metadataStatus:'available',source:null,verification:'external-attestation-required'});
    vi.stubGlobal('__CALLIOPE_BUILD_METADATA__',{...metadata(),source:{commit:'a'.repeat(40),dirty:true}});
    expect(buildIdentity().source?.dirty).toBe(true);
  });
  it('does not share mutable source metadata between callers',()=>{
    vi.stubGlobal('__CALLIOPE_BUILD_METADATA__',metadata());
    const first=buildIdentity();first.source!.commit='b'.repeat(40);
    expect(buildIdentity().source?.commit).toBe('a'.repeat(40));
  });
  it('reads package-local metadata and rejects malformed bytes without exposing them',()=>{
    const path=new URL('../src/build-metadata.json',import.meta.url),saved=existsSync(path)?readFileSync(path):undefined;
    try{
      writeFileSync(path,JSON.stringify(metadata()));
      expect(buildIdentity()).toMatchObject({artifact:'node-package',metadataStatus:'available',source:{commit:'a'.repeat(40)}});
      writeFileSync(path,'{invalid');expect(buildIdentity()).toMatchObject({metadataStatus:'invalid',source:null});
      rmSync(path);expect(buildIdentity()).toMatchObject({metadataStatus:'unavailable',source:null});
    }finally{if(saved)writeFileSync(path,saved);else rmSync(path,{force:true});}
  });
  it.each([
    {...metadata(),version:2},
    {...metadata(),package:{name:'another-package',version:getVersion()}},
    {...metadata(),package:{name:'@calliopelabs/cli',version:'0.0.0-mismatch'}},
    {...metadata(),source:{commit:'untrusted',dirty:false}},
    {...metadata(),source:{commit:'a'.repeat(40),dirty:'false'}},
    {...metadata(),verified:true},
  ])('refuses malformed or mismatched build metadata',value=>{
    expect(validBuildMetadata(value,getVersion())).toBe(false);
    vi.stubGlobal('__CALLIOPE_BUILD_METADATA__',value);
    expect(buildIdentity()).toMatchObject({metadataStatus:'invalid',source:null});
  });
});
