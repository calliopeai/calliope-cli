import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {newGoalManifest,plannerPlan,proposePlan,validateGoalManifest,validateGoalSupervision,validateSupervisedGoalPlan,goalSupervisionFlags,signed,GoalStore,runGoalCommand} from '../src/goals/index.js';
import {analyzePlan,RunStore} from '../src/orchestration/index.js';
import {goalImage,goalSupervision,supervisedGoalPlan} from './helpers/supervised-goal.js';
let root:string,project:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-supervised-goal-')));project=join(root,'project');fs.mkdirSync(project);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Schema tests cannot call providers.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const manifest=()=>newGoalManifest(project,'Verify the public toy project.',join(root,'runs'),{preference:{provider:'deepseek',model:'planner-toy'},supervision:goalSupervision(),team:{version:1,workers:{provider:'deepseek',model:'worker-toy'},maxAttempts:3}});
const source={kind:'agent' as const,runId:randomUUID(),artifactId:'proposal',artifactHash:'a'.repeat(64),eventId:randomUUID()},spend={tokens:10,costNanos:10,revision:'a'.repeat(64)};
it('persists v3 authority and generates a read-only planner with explicit v4 verification instructions',()=>{
  const m=manifest(),store=new GoalStore(join(root,'goals'));store.create(m);expect(new GoalStore(store.root).read(m.id).manifest).toEqual(m);expect(m.version).toBe(3);
  const p=plannerPlan(m);expect(analyzePlan(p).plan.version).toBe(2);expect(p.workspace.allowedTools).not.toContain('shell');expect(p.agents[0]!.allowedPaths.every(g=>g.access==='read')).toBe(true);
  const inputs=p.agents[0]!.inputs;expect(inputs.find(i=>i.id==='contract')!.value).toContain('version:4');expect(inputs.find(i=>i.id==='contract')!.value).toContain('1..8 verification commands');expect(JSON.parse(inputs.find(i=>i.id==='supervision-settings')!.value)).toEqual(m.supervision);
  const old=newGoalManifest(project,'Old goal.',m.runsRoot);expect(old.version).toBe(1);expect(plannerPlan(old).agents[0]!.inputs.find(i=>i.id==='contract')!.value).toContain('version:2');expect(old.workspace.allowedTools).not.toContain('shell');
  const {hash,...body}=m;for(const bad of [{version:2},{supervision:undefined},{workspace:{...m.workspace,allowedTools:['read_file']}},{limits:{...m.limits,maxAgents:2}},{limits:{...m.limits,maxDepth:0}},{limits:{...m.limits,tokenBudget:20,planningTokens:10,maxOutputTokens:10}}])expect(()=>validateGoalManifest(signed({...body,...bad}))).toThrow();
});
it('binds each requested model to its role and preserves explicit human revision choices',()=>{
  const m=manifest(),p=supervisedGoalPlan();for(const agent of p.agents)agent.preference={provider:'google',model:'unrequested'};
  const proposal=proposePlan(m,p,source,spend);expect(proposal.plan.agents.map(a=>a.preference.model)).toEqual(['controller-toy','worker-toy','reviewer-toy']);expect(proposal.plan.agents.every(a=>a.escalationPolicy.maxRetries===2)).toBe(true);
  const revised=supervisedGoalPlan();revised.agents[1]!.preference={provider:'google',model:'human-choice'};
  const human=proposePlan(m,revised,{kind:'human',path:'reviewed.json',sha256:'a'.repeat(64)},spend);expect(human.plan.agents.map(a=>a.preference.model)).toEqual(['controller-toy','human-choice','reviewer-toy']);
  const noTeam=newGoalManifest(project,'Independent controller.',m.runsRoot,{preference:m.preference,supervision:goalSupervision()});expect(proposePlan(noTeam,supervisedGoalPlan(),source,spend).plan.agents[0]!.preference).toEqual(m.supervision!.controller);
  const inherited=goalSupervision();delete inherited.controller;const fallback=newGoalManifest(project,'Inherited controller.',m.runsRoot,{preference:m.preference,supervision:inherited});expect(proposePlan(fallback,supervisedGoalPlan(),source,spend).plan.agents[0]!.preference).toEqual(m.preference);
});
it('rejects supervision downgrade, widening, missing verification and role confusion',()=>{
  const m=manifest();
  const edits:((p:ReturnType<typeof supervisedGoalPlan>)=>void)[]=[p=>{p.version=3;delete p.supervision;},p=>{p.workspace.isolation!.image='sha256:'+'b'.repeat(64);},p=>{p.supervision!.principle='speed';},p=>{p.supervision!.maxRounds=5;},p=>{p.supervision!.maxStalledRounds=3;},p=>{p.supervision!.maxOutputTokens=101;},p=>{delete p.supervision!.reviewerId;},p=>{p.supervision!.reasoningEffort={controller:'high'};},p=>{p.tasks[0]!.agentId='coordinator';},p=>{p.tasks[0]!.agentId='reviewer';},p=>{p.tasks[0]!.isolation!.commands=[];},p=>{p.agents[2]!.allowedTools.push('write_file');},p=>{p.agents[2]!.maxChildCount=1;},p=>{p.agents[2]!.maxChildDepth=1;}];
  for(const edit of edits){const p=supervisedGoalPlan();edit(p);expect(()=>validateSupervisedGoalPlan(p,m)).toThrow();}
  const narrowed=supervisedGoalPlan();narrowed.supervision!.maxRounds=2;narrowed.supervision!.maxStalledRounds=1;narrowed.supervision!.maxOutputTokens=50;narrowed.supervision!.allowedActions=['retry'];expect(()=>validateSupervisedGoalPlan(narrowed,m)).not.toThrow();
  const {hash,...body}=m,onlyRetry=signed({...body,supervision:{...m.supervision!,allowedActions:['retry'] as const}});expect(()=>validateSupervisedGoalPlan(supervisedGoalPlan(),onlyRetry as never)).toThrow();
  const noReviewer=structuredClone(m);delete noReviewer.supervision!.reviewer;expect(()=>validateSupervisedGoalPlan(supervisedGoalPlan(),noReviewer)).toThrow();delete narrowed.supervision!.reviewerId;expect(()=>validateSupervisedGoalPlan(narrowed,noReviewer)).not.toThrow();
});
it('validates settings and captures bounded CLI defaults without borrowing the planning reviewer',()=>{
  const s=goalSupervision();expect(goalSupervisionFlags({})).toBeUndefined();expect(goalSupervisionFlags({},s)).toEqual(s);
  expect(goalSupervisionFlags({supervise:true,'isolation-image':goalImage,'supervision-rounds':'1'})).toMatchObject({maxRounds:1,maxStalledRounds:1,maxOutputTokens:1024,principle:'robustness'});
  expect(goalSupervisionFlags({supervise:true,'supervision-stall-rounds':'1','controller-provider':'google','controller-model':'controller-new','supervision-reviewer-provider':'openrouter','supervision-reviewer-model':'reviewer-new','controller-effort':'high','supervision-reviewer-effort':'low'},s)).toMatchObject({controller:{provider:'google',model:'controller-new'},reviewer:{provider:'openrouter',model:'reviewer-new'},reasoningEffort:{controller:'high',reviewer:'low'}});
  for(const bad of [{image:'node:latest'},{version:2},{maxRounds:0},{maxRounds:65},{maxStalledRounds:5},{maxOutputTokens:8193},{principle:'magic'},{allowedActions:['merge']},{controller:{provider:'bad'}},{reviewer:{provider:'auto',model:''}},{reviewer:{provider:'auto',secret:'x'}},{reasoningEffort:{}},{reasoningEffort:{controller:'magic'}},{reviewer:undefined,reasoningEffort:{reviewer:'high'}}])expect(()=>validateGoalSupervision({...s,...bad})).toThrow();
  for(const supervision of [null,false,0,''])expect(()=>newGoalManifest(project,'Malformed supervision.',join(root,'runs'),{supervision:supervision as never})).toThrow();
  const clone=validateGoalSupervision(s);clone.allowedActions.pop();expect(s.allowedActions).toHaveLength(3);
});
it('rejects malformed controls and misplaced subcommand flags before discovery or goal creation',async()=>{
  const goals=new GoalStore(join(root,'goals')),lines:string[]=[],options={cwd:project,goals,store:new RunStore(join(root,'runs')),write:(line:string)=>lines.push(line)};
  const bad=[['--supervise'],['--principle','speed'],['--controller-provider','google'],['--supervise','--isolation-image','node:latest'],...['supervision-rounds','supervision-stall-rounds','supervision-output-tokens'].map(flag=>['--supervise','--isolation-image',goalImage,'--'+flag,'1.5']),['--supervise','--isolation-image',goalImage,'--controller-model','toy'],['--supervise','--isolation-image',goalImage,'--supervision-reviewer-model','toy'],['--supervise','--isolation-image',goalImage,'--supervision-reviewer-effort','high'],['--supervise','--isolation-image',goalImage,'--max-agents','1']];
  for(const flags of bad){expect(await runGoalCommand(['Public toy.',...flags,'--json'],options),flags.join(' ')).toBe(2);expect(JSON.parse(lines.at(-1)!).error).toBeDefined();}
  expect(await runGoalCommand(['resume',randomUUID(),'--supervise','--json'],options)).toBe(2);expect(goals.list(project).goals).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});
