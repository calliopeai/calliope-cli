import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigPath } from '../../config.js';
import { ChatGPTAuthError, type Registration } from './protocol.js';
export interface Account extends Registration { quotaCircuit?: { reason: 'quota' | 'rate-limit'; until: number }; accessToken?: string; refreshToken?: string; expiresAt?: number; earliestRefreshAt?: number; scopes: string[] }
export interface AuthState { version: 1; hostId: string; active?: string; accounts: Record<string, Account> }
export class ChatGPTStore {
  constructor(readonly directory = path.join(path.dirname(getConfigPath()), 'chatgpt-auth')) {}
  private file() { return path.join(this.directory, 'credentials.json'); }
  private check(target: string, directory = false) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
      throw new ChatGPTAuthError('ChatGPT credential storage must be private and owned by the current user.');
  }
  read(): AuthState | undefined {
    try {
      this.check(this.directory, true); this.check(this.file());
      const value = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as AuthState;
      if (value.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId) || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw Error();
      for (const [id, a] of Object.entries(value.accounts)) if (id !== a.clientId || !/^oaiapp_[\w-]+$/.test(id) || typeof a.subject !== 'string' || !a.subject || !Array.isArray(a.scopes) || !a.scopes.every(s => typeof s === 'string')) throw Error();
      for (const a of Object.values(value.accounts)) {
        for (const token of [a.accessToken, a.refreshToken, a.idToken]) if (token !== undefined && (typeof token !== 'string' || !token)) throw Error();
        if (a.quotaCircuit && (!['quota', 'rate-limit'].includes(a.quotaCircuit.reason) || !Number.isSafeInteger(a.quotaCircuit.until) || a.quotaCircuit.until <= 0)) throw Error();
        if (a.expiresAt !== undefined && (!Number.isFinite(a.expiresAt) || a.expiresAt <= 0)) throw Error();
      }
      if (value.active && !value.accounts[value.active]) throw Error();
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (e instanceof ChatGPTAuthError) throw e;
      throw new ChatGPTAuthError('ChatGPT credential storage is unreadable.');
    }
  }
  async update<T>(action: (state: AuthState) => T | Promise<T>): Promise<T> {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.check(this.directory, true);
    const lock = path.join(this.directory, 'lock');
    let fd: number;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch { throw new ChatGPTAuthError('ChatGPT credentials are busy. If no Calliope process is running, remove the chatgpt-auth/lock file and retry.'); }
    const temporary = `${this.file()}.${randomUUID()}.tmp`;
    try {
      const state = this.read() ?? { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: {} };
      const result = await action(state);
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file());
      return result;
    } finally { fs.closeSync(fd); fs.rmSync(temporary, { force: true }); fs.unlinkSync(lock); }
  }
  active(): Account | undefined { const state = this.read(); return state?.active ? state.accounts[state.active] : undefined; }
}
