import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildMetadata} from '../scripts/build-metadata.mjs';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'calliope-build-identity-'));roots.push(root);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@calliopelabs/cli',version:'3.6.0'}));return root;}
const git=(root:string,args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
it('records the exact committed source and distinguishes tracked and untracked changes',()=>{
  const root=fixture();git(root,['init']);git(root,['add','package.json']);
  git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture']);
  expect(buildMetadata(root)).toEqual({version:1,package:{name:'@calliopelabs/cli',version:'3.6.0'},source:{commit:git(root,['rev-parse','HEAD']),dirty:false}});
  writeFileSync(join(root,'untracked'),'fixture');expect(buildMetadata(root).source.dirty).toBe(true);rmSync(join(root,'untracked'));
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@calliopelabs/cli',version:'3.6.1'}));expect(buildMetadata(root).source.dirty).toBe(true);
});
it('does not invent source identity without a repository or inherit an enclosing repository',()=>{
  const root=fixture();expect(buildMetadata(root).source).toBe(null);git(root,['init']);
  git(root,['add','package.json']);git(root,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture']);
  const nested=join(root,'extracted');mkdirSync(nested);writeFileSync(join(nested,'package.json'),JSON.stringify({name:'@calliopelabs/cli',version:'3.6.0'}));
  expect(buildMetadata(nested).source).toBe(null);
});
