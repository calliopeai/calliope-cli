/** Library callers must fail before paid or host effects when capture cannot be retained. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {runTurn} from '../src/runtime/index.js';

type Options = Parameters<typeof runTurn>[0];
let cwd:string;
beforeEach(()=>{
 config.resetConfig();cwd=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-capture-admission-')));
 vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Capture denial must precede provider access');}));
});
afterEach(()=>{config.resetConfig();vi.unstubAllGlobals();fs.rmSync(cwd,{recursive:true,force:true});});

const denied:Array<{name:string;options:Partial<Options>;error:RegExp}>=[
 {name:'version without capture',options:{runtimeStateVersion:2},error:/version requires capture/},
 {name:'unsupported version',options:{retainRuntimeState:true,runtimeStateVersion:3 as unknown as 2},error:/version requires capture/},
 {name:'non-boolean capture',options:{retainRuntimeState:'yes' as unknown as boolean},error:/explicit boolean/},
 {name:'acknowledgment without capture',options:{onRuntimeStateCommitted:async()=>{}},error:/capture and a host callback/},
 {name:'non-callable acknowledgment',options:{retainRuntimeState:true,onRuntimeStateCommitted:true as unknown as Options['onRuntimeStateCommitted']},error:/capture and a host callback/},
 {name:'capture without a writer',options:{retainRuntimeState:true},error:/checkpoint writer/},
 {name:'allowance retention without a writer',options:{retainTurnProgress:true},error:/checkpoint writer/},
];
it.each(denied)('denies $name before provider or presentation effects',async({options,error})=>{
 const presented=vi.fn(),checkpoint=vi.fn();
 const input:Options={cwd,sessionId:randomUUID(),provider:'anthropic',model:'fixture',prompt:'Original goal',
  messages:{current:[{role:'user',content:'Original goal'}]},confirmation:'none',tools:()=>[],
  onResponse:presented,...options};
 // Invalid callback input also fails with a writer present; the callback itself is the invalid authority.
 if(options.onRuntimeStateCommitted!==undefined)input.onCheckpoint=checkpoint;
 await expect(runTurn(input)).rejects.toThrow(error);
 expect(fetch).not.toHaveBeenCalled();expect(presented).not.toHaveBeenCalled();expect(checkpoint).not.toHaveBeenCalled();
});
