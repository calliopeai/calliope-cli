import * as fs from 'node:fs';
import {dirname,basename,join} from 'node:path';
import {canonicalPath} from '../approvals/index.js';

/** A retained hard-link claim elects one reclaimer per dead writer inode. */
export function recoverDeadWriterLock(file:string):boolean {
  try {
    if(!['writer.lock','owner.lock'].includes(basename(file))||canonicalPath(file)!==file)return false;
    const root=dirname(file),parent=fs.lstatSync(root);if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077)return false;
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let stat:fs.Stats,pid:number;
    try{stat=fs.fstatSync(fd);if(!stat.isFile()||stat.mode&0o077||stat.size<1||stat.size>10)return false;const bytes=Buffer.alloc(stat.size+1),count=fs.readSync(fd,bytes,0,bytes.length,0),raw=bytes.subarray(0,count).toString();if(count!==stat.size||!/^\d{1,10}$/.test(raw))return false;pid=Number(raw);if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647)return false;}finally{fs.closeSync(fd);}
    try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;}
    const recovery=join(root,'lock-recovery');try{fs.mkdirSync(recovery,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')return false;}
    const dir=fs.lstatSync(recovery);if(!dir.isDirectory()||dir.isSymbolicLink()||dir.mode&0o077||canonicalPath(recovery)!==recovery)return false;
    const entries=fs.opendirSync(recovery);let count=0;try{while(entries.readSync())if(++count>=64)return false;}finally{entries.closeSync();}
    const claim=join(recovery,`${basename(file)}-${stat.dev}-${stat.ino}`);fs.linkSync(file,claim);
    const captured=fs.lstatSync(claim),current=fs.lstatSync(file),after=fs.lstatSync(root);
    if(captured.dev!==stat.dev||captured.ino!==stat.ino||current.dev!==stat.dev||current.ino!==stat.ino||after.dev!==parent.dev||after.ino!==parent.ino||canonicalPath(file)!==file)return false;
    for(const path of [recovery,root]){const directory=fs.openSync(path,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
    fs.unlinkSync(file);const directory=fs.openSync(root,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}return true;
  }catch{return false;}
}
