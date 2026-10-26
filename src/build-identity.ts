import {readFileSync} from 'node:fs';
import {getVersion} from './version-check.js';

export interface BuildMetadata {
  version:1;package:{name:'@calliopelabs/cli';version:string};
  source:{commit:string;dirty:boolean}|null;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function validBuildMetadata(value:unknown,packageVersion:string):value is BuildMetadata {
  if(!record(value)||Object.keys(value).sort().join(',')!=='package,source,version'||value.version!==1||!record(value.package)||
    Object.keys(value.package).sort().join(',')!=='name,version'||value.package.name!=='@calliopelabs/cli'||value.package.version!==packageVersion)return false;
  return value.source===null||record(value.source)&&Object.keys(value.source).sort().join(',')==='commit,dirty'&&
    typeof value.source.commit==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.source.commit)&&typeof value.source.dirty==='boolean';
}

/** Never runs Git or reads the current project. Self-reported identity is not attestation verification. */
export function buildIdentity() {
  const packageVersion=getVersion();
  const injected=(globalThis as {__CALLIOPE_BUILD_METADATA__?:unknown}).__CALLIOPE_BUILD_METADATA__;
  let metadata:unknown=injected,status:'available'|'unavailable'|'invalid'='available';
  if(injected===undefined) {
    try{metadata=JSON.parse(readFileSync(new URL('./build-metadata.json',import.meta.url),'utf8'));}
    catch(error){status=error instanceof SyntaxError?'invalid':'unavailable';}
  }
  if(status==='available'&&!validBuildMetadata(metadata,packageVersion))status='invalid';
  const source=status==='available'?(metadata as BuildMetadata).source:null;
  return {package:{name:'@calliopelabs/cli' as const,version:packageVersion},
    artifact:injected===undefined?'node-package' as const:'standalone' as const,
    metadataStatus:status,source:source?{...source}:null,
    verification:'external-attestation-required' as const};
}
