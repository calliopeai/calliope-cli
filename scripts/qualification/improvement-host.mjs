/** Exercise actual built/package discovery from outside its source tree; no inference. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const packageRoot=process.env.CALLIOPE_IMPROVEMENT_HOST_PACKAGE??fileURLToPath(new URL('../../',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'calliope-improvement-host-')),project=join(root,'unrelated-project');
mkdirSync(project);
try {
  const pkg=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
  const metadata=JSON.parse(readFileSync(join(packageRoot,'dist/build-metadata.json'),'utf8'));
  const invoke=(args,code=0)=>{
    const result=spawnSync(process.execPath,[join(packageRoot,'dist/bin.js'),'improve',...args,'--json'],{
      cwd:project,env:{PATH:process.env.PATH,HOME:join(root,'home'),USERPROFILE:join(root,'home'),
        CALLIOPE_CONFIG_DIR:join(root,'config'),NO_COLOR:'1'},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
    assert.equal(result.error,undefined);assert.equal(result.status,code,result.stderr);
    return JSON.parse(result.stdout);
  };
  const value=invoke(['host-capabilities','--contract-version','1']);
  assert.equal(value.data.kind,'improvement.host-capabilities');
  assert.equal(value.data.implementation.package.version,pkg.version);
  assert.equal(value.data.implementation.artifact,'node-package');
  assert.equal(value.data.implementation.metadataStatus,'available');
  assert.deepEqual(value.data.implementation.source,metadata.source);
  assert.equal(value.data.implementation.verification,'external-attestation-required');
  assert.equal(value.data.interfaces.execution.mechanisms.crossRunLearnedStrategy,false);
  assert.equal(invoke(['capabilities']).data.version,2,'Legacy discovery must retain its version');
  for(const args of [['host-capabilities','--contract-version','999'],['host-capabilities','--run','foreign'],['host-capabilities','--allow-mutations']]){
    assert.equal(invoke(args,2).error.code,'invalid');
  }
  const api=await import(pathToFileURL(join(packageRoot,'dist/improvement/index.js')).href);
  for(const name of ['improvementHostCapabilities','inspectImprovements','proposeImprovement','runImprovement',
    'withdrawImprovement','requestImprovementReview','inspectImprovementReviews','dismissImprovementReview',
    'inspectTaskOutcome','previewSourceChange','proposeSourceChange','inspectSourceChange','listSourceChanges'])assert.equal(typeof api[name],'function',name);
  assert.deepEqual(readdirSync(project),[],'Discovery must not open or mutate the caller project');
  console.log(JSON.stringify({version:1,passed:true,artifact:'node-package',packageVersion:pkg.version,
    metadataMatches:true,legacyCompatible:true,unsupportedRefused:true,projectUnchanged:true,inferenceRequests:0}));
} finally {rmSync(root,{recursive:true,force:true});}
