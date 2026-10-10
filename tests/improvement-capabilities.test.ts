import {describe,expect,it,vi} from 'vitest';
import {improvementCapabilities,runImprovementCommand} from '../src/improvement/index.js';

describe('native improvement host discovery',()=>{
  it('advertises existing mechanisms without opening a project or requesting authority',async()=>{
    const lines:string[]=[],approve=vi.fn(()=>{throw Error('Unexpected approval');});
    const code=await runImprovementCommand(['capabilities','--json'],{cwd:'/nonexistent-capability-project',approve,write:line=>lines.push(line)});
    expect(code).toBe(0);expect(approve).not.toHaveBeenCalled();expect(lines).toHaveLength(1);
    const result=JSON.parse(lines[0]!);
    expect(result).toMatchObject({version:1,type:'improvement',action:'capabilities',localOnly:true,data:{
      version:1,kind:'improvement.capabilities',owner:'calliope-cli',mechanisms:{recursiveTaskStrategy:true,
        crossRunLearnedStrategy:false,modelTraining:false,externalFeedbackImport:false},
      historyVersions:[1,2,3],scope:{requiredPlanVersion:4,activation:'exact-proposal-hash-and-native-policy'}}});
    expect(result.data.operations.history).toEqual({mode:'read-only',mayCallModel:false});
    expect(result.data.operations.propose.mayCallModel).toBe(true);
    expect(result.data.operations.rollback.mayCallModel).toBe(false);
    expect(result.data.scope.rollback).toContain('no-source-inverse-or-refund');
  });
  it.each([{args:['--run','foreign']},{args:['--allow-mutations']},{args:['--approve','hash']},{args:['extra']},{args:['--run=']},{args:['--approve=']}])('rejects execution arguments $args',async({args})=>{
    const lines:string[]=[];
    expect(await runImprovementCommand(['capabilities',...args,'--json'],{write:line=>lines.push(line)})).toBe(2);
    expect(JSON.parse(lines[0]!).error.code).toBe('invalid');
  });
  it('honors cancellation and describes unsupported mechanisms in human output',async()=>{
    const lines:string[]=[];
    expect(await runImprovementCommand(['capabilities','--json'],{signal:AbortSignal.abort(),write:line=>lines.push(line)})).toBe(130);
    expect(JSON.parse(lines[0]!).error.code).toBe('cancelled');
    const human:string[]=[];expect(await runImprovementCommand(['capabilities'],{write:line=>human.push(line)})).toBe(0);
    expect(human[0]).toContain('Unavailable: external feedback import');
  });
  it('does not let one host mutate another discovery result',()=>{
    const one=improvementCapabilities();(one.historyVersions as unknown as number[]).push(999);
    expect(improvementCapabilities().historyVersions).toEqual([1,2,3]);
  });
});
