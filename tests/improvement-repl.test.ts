import {it,expect,vi,afterEach} from 'vitest';
import {handleCommand,type CommandContext} from '../src/ui/commands.js';
import * as improvement from '../src/improvement/index.js';
afterEach(()=>vi.restoreAllMocks());
it('binds improvement controls to the active project, cancellation, permission callback and HUD',async()=>{
  const signal=new AbortController().signal,approve=vi.fn(async()=> 'allow' as const),onProgress=vi.fn(),messages:string[]=[];
  const run=vi.spyOn(improvement,'runImprovementCommand').mockImplementation(async(args,options)=>{expect(args).toEqual(['history','--run','public-run','--json']);expect(options).toMatchObject({cwd:'/active/project',signal,source:'repl',confirmation:'mutating',onProgress});expect(await options!.approve!({} as never,signal)).toBe('allow');options!.write!('Public diagnostic\n');return 0;});
  const ctx={sessionRef:{current:{projectPath:'/active/project'}},signal,confirmMode:true,approve,onWorkflowProgress:onProgress,addMessage:(_kind:string,text:string)=>messages.push(text)} as unknown as CommandContext;
  await handleCommand('/improve history --run "public-run" --json',ctx);expect(run).toHaveBeenCalledOnce();expect(approve).toHaveBeenCalledWith({},signal);expect(messages).toEqual(['Public diagnostic']);
});
