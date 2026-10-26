/** Build identity is descriptive; release attestations remain the trust boundary. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function buildMetadata(root) {
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  let source=null;
  try {
    const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000,maxBuffer:1024*1024}).trim();
    // An extracted package inside a different repository must not inherit its identity.
    if(realpathSync(git(['rev-parse','--show-toplevel']))===realpathSync(root)) {
      const commit=git(['rev-parse','HEAD']);
      if(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))source={commit,dirty:git(['status','--porcelain','--untracked-files=normal'])!==''};
    }
  } catch {/* Missing Git/source identity remains explicitly unknown. */}
  return {version:1,package:{name:pkg.name,version:pkg.version},source};
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=fileURLToPath(new URL('../',import.meta.url));
  mkdirSync(join(root,'dist'),{recursive:true});
  writeFileSync(join(root,'dist/build-metadata.json'),JSON.stringify(buildMetadata(root))+'\n');
}
