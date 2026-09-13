import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {newGoalManifest,plannerPlan,proposePlan,validateGoalManifest,validateGoalTeam,signed,GoalStore,runGoalCommand,type GoalManifest} from '../src/goals/index.js';
import {analyzePlan,RunStore} from '../src/orchestration/index.js';
import {verifiedPlan} from './helpers/coordinator-run.js';

let root:string,project:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-team-')));project=join(root,'project');fs.mkdirSync(project);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network in team schema tests.');}));});
afterEach(()=>{config.resetConfig();saveHooks([]);vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const teamGoal=()=>newGoalManifest(project,'Inspect a public toy project.',join(root,'runs'),{preference:{provider:'anthropic',model:'planner-toy'},team:{version:1,reviewer:{provider:'openrouter',model:'reviewer-toy'},workers:{provider:'deepseek',model:'worker-toy'},maxAttempts:3}});
const source={kind:'agent' as const,runId:randomUUID(),artifactId:'proposal',artifactHash:'a'.repeat(64),eventId:randomUUID()};
const spend={tokens:10,costNanos:10,revision:'a'.repeat(64)};
it('persists a versioned team and builds a bounded read-only planner/reviewer dependency',()=>{
  const manifest=teamGoal(),store=new GoalStore(join(root,'goals'));store.create(manifest);
  expect(new GoalStore(store.root).read(manifest.id).manifest).toEqual(manifest);expect(manifest.version).toBe(2);
  const plan=plannerPlan(manifest),analysis=analyzePlan(plan);expect(analysis.stages).toEqual([['draft'],['propose']]);
  expect(plan.agents.map(agent=>agent.preference)).toEqual([{provider:'anthropic',model:'planner-toy'},{provider:'openrouter',model:'reviewer-toy'}]);
  expect(plan.tasks[1]!.inputs).toContainEqual({id:'draft-evidence',kind:'artifact',value:'draft'});
  expect(plan.tasks[1]!.outputs.map(output=>output.id)).toEqual(['proposal','plan-review']);
  expect(plan.workspace.allowedTools).not.toContain('write_file');expect(plan.agents.every(agent=>agent.allowedPaths.every(path=>path.access==='read'))).toBe(true);
  expect(plan.limits.costBudgetUsd).toBe(manifest.limits.planningCostNanos/1e9);expect(plan.agents[1]!.costBudgetUsd).toBeLessThanOrEqual(plan.limits.costBudgetUsd/2);
  expect(plan.agents[0]!.inputs.find(input=>input.id==='contract')!.value).toContain('inline "draft" output');expect(plan.agents[1]!.inputs.find(input=>input.id==='contract')!.value).toContain('inline "proposal" output');
});
it('binds operator choices before review while human revisions can select individual workers under the attempt ceiling',()=>{
  const m=teamGoal(),p=verifiedPlan();p.agents[1]!.preference={provider:'google',model:'unrequested-toy'};
  const proposed=proposePlan(m,p,source,spend);expect(proposed.plan.agents[0]!.preference).toEqual(m.preference);
  for(const worker of proposed.plan.agents.slice(1)){expect(worker.preference).toEqual(m.team!.workers);expect(worker.escalationPolicy.maxRetries).toBe(2);}
  const human=proposePlan(m,p,{kind:'human',path:'plan.json',sha256:'a'.repeat(64)},spend);expect(human.plan.agents[1]!.preference).toEqual({provider:'google',model:'unrequested-toy'});expect(human.inferred).toBe(false);
  const onlyWorkers=newGoalManifest(project,'Toy.',m.runsRoot,{team:{version:1,workers:{provider:'google'}}});expect(plannerPlan(onlyWorkers).tasks).toHaveLength(1);
});
it('rejects malformed teams, version confusion, and reviewer limits before creating a goal',async()=>{
  for(const team of [{},{version:2,workers:{provider:'auto'}},{version:1},{version:1,workers:{provider:'nope'}},{version:1,workers:{provider:'auto',model:''}},{version:1,reviewer:null},{version:1,maxAttempts:0},{version:1,maxAttempts:5},{version:1,maxAttempts:1.5},{version:1,workers:{provider:'auto',token:'secret'}}])expect(()=>validateGoalTeam(team)).toThrow();
  const m=teamGoal(),{hash,...body}=m;
  for(const limits of [{maxAgents:1},{maxTasks:1},{maxDepth:0},{planningTokens:1}])expect(()=>validateGoalManifest(signed({...body,limits:{...body.limits,...limits}}))).toThrow();
  for(const version of [1,'2',3])expect(()=>validateGoalManifest(signed({...body,version}))).toThrow();
  const goals=new GoalStore(join(root,'goals')),lines:string[]=[],options={cwd:project,goals,store:new RunStore(m.runsRoot),write:(line:string)=>lines.push(line)};
  for(const args of [['--worker-model','toy'],['--reviewer-model','toy'],['--worker-provider','bad'],['--attempts','5'],['--attempts','1.0'],['--planner-provider','google','--provider','google'],['--planner-model','toy','--model','toy'],['--reviewer-provider','google','--max-agents','1']]){
    expect(await runGoalCommand(['Toy.',...args,'--json'],options)).toBe(2);expect(JSON.parse(lines.at(-1)!).error).toBeDefined();
  }
  expect(goals.list(project).goals).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();
});

it('captures opt-in role pools without changing legacy goals or inheriting a pinned planner into workers',async()=>{
  const {agentPreference}=await import('../src/orchestration/progress.js');
  const policy={version:1 as const,profile:'cost' as const,pool:[{provider:'deepseek' as const,model:'worker-live'}]};
  const routing={version:1 as const,default:policy,planner:{...policy,profile:'balanced' as const,pool:[{provider:'anthropic' as const}]}};
  const m=newGoalManifest(project,'Inspect toy.',join(root,'runs'),{preference:{provider:'anthropic',model:'planner-live'},routing,planningRepairs:1});
  expect(m.version).toBe(5);expect(plannerPlan(m).agents[0]!.routing).toEqual(routing.planner);
  const store=new GoalStore(join(root,'goals'));store.create(m);expect(plannerPlan(store.read(m.id).manifest)).toEqual(plannerPlan(m));
  const draft=verifiedPlan();draft.agents[1]!.preference={provider:'google',model:'model-proposed-escape'};const proposal=proposePlan(m,draft,source,spend);expect(proposal.plan.agents[1]!.routing).toEqual(policy);expect(agentPreference(proposal.plan,'a')).toEqual({provider:'auto',model:null});
  expect(proposal.plan.agents[0]!.childRouting).toEqual(policy);
  expect(agentPreference(proposal.plan,'coordinator')).toEqual({provider:'anthropic',model:'planner-live'});
  expect(teamGoal().version).toBe(2);expect(plannerPlan(teamGoal()).agents.every(a=>a.routing===undefined)).toBe(true);
  const changed=structuredClone(m);changed.routing!.default.pool[0]!.model='other';expect(()=>validateGoalManifest(changed)).toThrow(/hash/);
});
it('requires the explicit Smart flag, validates policy files and checks read permission before planning',async()=>{
  const policy={version:1,default:{version:1,profile:'cost',pool:[{provider:'deepseek'}]}};
  fs.writeFileSync(join(project,'routing.json'),JSON.stringify(policy),{mode:0o600});
  const {loadGoalRouting,validateGoalRouting}=await import('../src/goals/routing.js');
  expect(await loadGoalRouting(project,'routing.json',{})).toEqual(policy);
  config.set('policy',{command:'exit 17'});
  await expect(loadGoalRouting(project,'routing.json',{})).rejects.toThrow(/policy/);config.set('policy',{});
  await expect(loadGoalRouting(project,'routing.json',{signal:AbortSignal.abort()})).rejects.toThrow();
  fs.symlinkSync(join(project,'routing.json'),join(project,'alias.json'));await expect(loadGoalRouting(project,'alias.json',{})).rejects.toThrow(/canonical/);
  await expect(loadGoalRouting(project,'../outside.json',{})).rejects.toThrow();
  for(const args of [['Inspect','--routing','auto'],['Inspect','--routing','smart'],['Inspect','--routing-policy','routing.json']]){
    const lines:string[]=[];expect(await runGoalCommand([...args,'--json'],{cwd:project,goals:new GoalStore(join(root,'goals')),write:line=>lines.push(line)})).toBe(2);expect(JSON.parse(lines[0]!).error.message).toContain('--routing smart');
  }
  for(const value of [{...policy,version:2},{...policy,default:{version:1,profile:'quality',pool:[]}},{...policy,other:policy.default}])expect(()=>validateGoalRouting(value)).toThrow();
  fs.writeFileSync(join(project,'routing.json'),'{malformed');await expect(loadGoalRouting(project,'routing.json',{})).rejects.toThrow(/valid JSON/);expect(fetch).not.toHaveBeenCalled();
});
