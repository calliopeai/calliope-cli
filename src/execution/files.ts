import * as fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalPath } from '../approvals/index.js';
import { throwIfCancelled } from '../cancellation.js';
import type { FsDelegate } from '../tools.js';
import type { ExecutionGuard } from './guard.js';
import { accountLineage, permits } from './authority.js';
import { ExecutionLimitError } from './types.js';
import type { ToolCall } from '../types.js';

const MAX_FILE_BYTES=1024*1024;
/** One delegate per tool call: edits bind to the bytes read during that call. */
export function agentFiles(guard:ExecutionGuard,agentId:string,call:ToolCall,signal?:AbortSignal):FsDelegate {
  const snapshots=new Map<string,{hash:string;mode:number}|null>();
  const check=(file:string)=>{
    throwIfCancelled(signal);
    const reason=guard.check({id:'agent-file',name:call.name,arguments:{path:file}});
    if(reason)throw new ExecutionLimitError('authority',reason);
  };
  const read=(file:string):{content:string;hash:string;mode:number}|null=>{
    file=guard.filePath(file);
    let fd:number;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new ExecutionLimitError('authority','Agent file must be a regular file no larger than 1 MiB.');
      const buffer=Buffer.alloc(stat.size+1);let size=0,n:number;while(size<buffer.length&&(n=fs.readSync(fd,buffer,size,buffer.length-size,null))>0)size+=n;
      if(size!==stat.size)throw new ExecutionLimitError('conflict','File changed during the read.');return {content:buffer.subarray(0,size).toString('utf8'),hash:createHash('sha256').update(buffer.subarray(0,size)).digest('hex'),mode:stat.mode&0o777};
    }finally{fs.closeSync(fd);}
  };
  return {
    readTextFile:async file=>{guard.assertActive(signal);check(file);const value=read(file);snapshots.set(file,value?{hash:value.hash,mode:value.mode}:null);if(!value)throw new Error('File not found.');check(file);return value.content;},
    writeTextFile:async(file,content)=>{
      guard.assertActive(signal);check(file);if(Buffer.byteLength(content)>MAX_FILE_BYTES)throw new ExecutionLimitError('limit','Agent file output exceeds 1 MiB.');
      const expected=snapshots.get(file);if(expected===undefined)throw new ExecutionLimitError('conflict','Agent writes require a preceding file snapshot.');
      const physical=guard.filePath(file),parent=dirname(physical),missing:string[]=[];let dir=parent;
      while(!fs.existsSync(dir)){missing.push(dir);const next=dirname(dir);if(next===dir||missing.length>64)throw new ExecutionLimitError('authority','Parent directory is outside the bounded write scope.');dir=next;}
      const account=accountLineage(guard.manifest,agentId)[0]!;
      for(const path of missing.reverse()){
        if(!permits(account.allowedPaths,relative(guard.filesRoot,path),'write')||canonicalPath(path)!==path)throw new ExecutionLimitError('authority','Creating a parent directory exceeds the agent write grant.');
        check(file);fs.mkdirSync(path,{mode:0o700});
      }
      const before=fs.statSync(parent),temp=join(parent,`.calliope-${randomUUID()}.tmp`);
      try{
        const current=read(file);if((current?.hash??null)!==(expected?.hash??null))throw new ExecutionLimitError('conflict','File changed after the agent read it; refresh before editing.');
        const fd=fs.openSync(temp,'wx',expected?.mode??0o600);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        guard.assertActive(signal);check(file);const after=fs.statSync(parent);if(before.ino!==after.ino||before.dev!==after.dev)throw new ExecutionLimitError('conflict','Parent directory changed before file commit.');
        const latest=read(file);if((latest?.hash??null)!==(expected?.hash??null))throw new ExecutionLimitError('conflict','File changed before commit.');
        fs.renameSync(temp,physical);const directory=fs.openSync(parent,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      }finally{try{const after=fs.statSync(parent);if(canonicalPath(parent)===parent&&after.ino===before.ino&&after.dev===before.dev)fs.unlinkSync(temp);}catch{/* Committed or replaced. */}}
    },
    listFiles:async(file,recursive)=>{
      guard.assertActive(signal);
      const output:string[]=[];let count=0;
      const walk=(dir:string,depth:number)=>{
        check(dir);if(depth>5||count>=1000)return;const handle=fs.opendirSync(guard.filePath(dir));
        try{let entry:fs.Dirent|null;while(count<1000&&(entry=handle.readSync())){throwIfCancelled(signal);if(Date.now()>=guard.deadline)throw new ExecutionLimitError('deadline','Agent deadline expired.');count++;
          const path=join(dir,entry.name);output.push(`${entry.isDirectory()?'📁 ':'📄 '}${relative(file,path)}`);
          if(recursive&&entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.'))walk(path,depth+1);
        }}finally{handle.closeSync();}
      };
      walk(file,0);if(count>=1000)output.push('[Listing limited to 1,000 entries.]');return output.join('\n')||'(empty directory)';
    },
  };
}
