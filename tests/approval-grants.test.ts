import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ApprovalStore, ApprovalQueue, ApprovalError, describeApproval, canonicalJson, canonicalPath, projectIdentity, digest,
  SESSION_GRANT_TTL, PROJECT_GRANT_TTL, MAX_APPROVAL_EVENTS, MAX_APPROVAL_BYTES, permissionsCommand, runPermissions,
  type ApprovalChoice, type PendingApproval } from '../src/approvals/index.js';
import { resolvePermission, type PermissionContext } from '../src/runtime/index.js';
import { executeTool } from '../src/tools.js';
import * as config from '../src/config.js';
import * as hooks from '../src/hooks.js';
import * as policy from '../src/policy.js';
import { scopeManager } from '../src/scope.js';
import { RunLog, resetRunLogs, readRunLog, verifyChain } from '../src/runlog.js';
import type { ToolCall } from '../src/types.js';
import { buildSeatbeltProfile } from '../src/sandbox/index.js';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let root: string, cwd: string, store: ApprovalStore, now: number;
const call: ToolCall = { id: 'one', name: 'write_file', arguments: { path: 'toy.txt', content: 'private-fixture-content' } };
const context = (): PermissionContext => ({ cwd, confirmation: 'interactive', approvals: store, sessionId: 'one' });
const file = () => join(root, 'approvals', 'history.json');
beforeEach(() => {
  config.resetConfig(); resetRunLogs();
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-approvals-'))); cwd = join(root, 'project'); fs.mkdirSync(cwd);
  scopeManager.reset(cwd); config.set('sandboxMode', 'off');
  now = Date.now(); store = new ApprovalStore(join(root, 'approvals'), () => now);
});
afterEach(() => { vi.restoreAllMocks(); config.resetConfig(); resetRunLogs(); fs.rmSync(root, { recursive: true, force: true }); });

it('binds exact arguments, canonical project/path, policy and scope without exposing content', () => {
  const request = describeApproval(call, cwd);
  expect(request.reusable).toBe(true); expect(request.details.join('\n')).toContain(join(cwd, 'toy.txt'));
  expect(JSON.stringify(request)).not.toContain('private-fixture-content');
  expect(describeApproval({ ...call, id: 'other', arguments: { content: 'private-fixture-content', path: 'toy.txt' } }, cwd).key).toBe(request.key);
  expect(describeApproval({ ...call, arguments: { ...call.arguments, content: 'other' } }, cwd).key).not.toBe(request.key);
  scopeManager.addDirectory(root); expect(describeApproval(call, cwd).key).not.toBe(request.key); scopeManager.reset(cwd);
  config.set('policy', { command: 'echo allow' }); expect(describeApproval(call, cwd).key).not.toBe(request.key);
  expect(describeApproval({ id: 'shell', name: 'shell', arguments: { command: 'npm publish' } }, cwd).reusable).toBe(false);
  expect(describeApproval({ ...call, arguments: { path: '../outside', content: '' } }, cwd).reusable).toBe(false);
});

it('shows the complete command while escaping terminal control characters and redacting known secrets', () => {
  const command = 'echo ' + 'long '.repeat(40) + 'END\x1b[2J sk-' + 'a'.repeat(40) + ' TOKEN="opaque credential"\u202e';
  const details = describeApproval({ ...call, name: 'shell', arguments: { command } }, cwd).details.join('\n');
  expect(details).toContain('END\\u001b[2J'); expect(details).toContain('[REDACTED]'); expect(details).not.toContain('sk-' + 'a'.repeat(40));
  expect(details).not.toContain('opaque credential'); expect(details).toContain('TOKEN=[REDACTED]\\u202e');
});

it('records once/session/project choices and keeps session grants out of restart and other sessions', async () => {
  const approve = vi.fn(async () => 'allow' as ApprovalChoice);
  expect((await resolvePermission(call, { ...context(), approve })).decision).toBe('allow');
  expect(store.find(describeApproval(call, cwd), 'one')).toBeUndefined();
  approve.mockResolvedValue('allow_session');
  expect((await resolvePermission(call, { ...context(), approve })).decision).toBe('allow');
  expect((await resolvePermission(call, { ...context(), approve })).decision).toBe('allow'); expect(approve).toHaveBeenCalledTimes(2);
  expect(store.find(describeApproval(call, cwd), 'two')).toBeUndefined();
  expect(new ApprovalStore(store.dir).find(describeApproval(call, cwd), 'one')).toBeUndefined();
  expect(fs.existsSync(file())).toBe(false);
  store.clearSession('one'); approve.mockResolvedValue('allow_project');
  expect((await resolvePermission(call, { ...context(), approve })).decision).toBe('allow');
  const restarted = new ApprovalStore(store.dir);
  expect(restarted.find(describeApproval(call, cwd), 'two')?.scope).toBe('project');
  expect(fs.statSync(file()).mode & 0o777).toBe(0o600); expect(fs.statSync(store.dir).mode & 0o777).toBe(0o700);
  expect(fs.readFileSync(file(), 'utf8')).not.toContain('private-fixture-content');
});

it('expires grants and appends revocation/reset events while preserving immutable earlier IDs', () => {
  const request = describeApproval(call, cwd);
  const session = store.grant(request, 'session', 'one'), project = store.grant(request, 'project');
  now += SESSION_GRANT_TTL + 1; expect(store.list(request.projectKey, 'one').grants.map(grant => grant.id)).toEqual([project.id]);
  expect(session.expiresAt).toBeLessThan(now);
  const original = JSON.parse(fs.readFileSync(file(), 'utf8')).events[0];
  store.revoke(request.projectKey, project.id); expect(store.find(request)).toBeUndefined();
  store.grant(request, 'project'); store.revoke(request.projectKey);
  expect(store.list(request.projectKey).grants).toEqual([]);
  expect(JSON.parse(fs.readFileSync(file(), 'utf8')).events[0]).toEqual(original);
  const later = store.grant(request, 'project'); now += PROJECT_GRANT_TTL + 1;
  expect(store.find(request)).toBeUndefined(); expect(later.expiresAt).toBeLessThan(now);
});

it('refuses code/plugin or cross-project reusable grants and rechecks policy instead of inheriting authority', async () => {
  const request = describeApproval(call, cwd); store.grant(request, 'project');
  const deny = vi.spyOn(hooks, 'checkHooksAllow').mockResolvedValue({ allowed: false, reason: 'frozen' });
  expect(await resolvePermission(call, context())).toMatchObject({ decision: 'deny', layer: 'hook' }); deny.mockRestore();
  vi.spyOn(policy, 'isPolicyEnabled').mockReturnValue(true); vi.spyOn(policy, 'evaluatePolicy').mockResolvedValue({ decision: 'deny', source: 'policy', durationMs: 0, reason: 'frozen' });
  expect(await resolvePermission(call, context())).toMatchObject({ decision: 'deny', layer: 'policy' });
  const shell = describeApproval({ ...call, name: 'shell', arguments: { command: 'npm publish' } }, cwd);
  expect(() => store.grant(shell, 'project')).toThrow(/cannot receive/);
  expect(() => store.grant(request, 'session')).toThrow(/cannot receive/);
});

it('rejects operation and policy changes during approval before storing a grant', async () => {
  const mutable = structuredClone(call);
  expect(await resolvePermission(mutable, { ...context(), approve: async () => { mutable.arguments.content = 'changed'; return 'allow_project'; } })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('changed') });
  expect(await resolvePermission(call, { ...context(), approve: async () => { config.set('policy', { command: 'echo policy' }); return 'allow_project'; } })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('changed') });
  expect(fs.existsSync(file())).toBe(false);
});

it('rechecks mode/session after approval and does not expose mutable session grant authority', async () => {
  const opts = context(); opts.approve = async () => { opts.mode = 'plan'; return 'allow_session'; };
  expect(await resolvePermission(call, opts)).toMatchObject({ decision: 'deny', layer: 'mode' });
  const next = context(); next.approve = async () => { next.sessionId = 'other'; return 'allow_project'; };
  expect(await resolvePermission(call, next)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('Session changed') });
  const request = describeApproval(call, cwd), grant = store.grant(request, 'session', 'one');
  grant.key = digest('forged'); grant.sessionId = 'other';
  const visible = store.list(request.projectKey, 'one').grants[0]!; visible.expiresAt = 1;
  expect(store.find(request, 'one')).toMatchObject({ key: request.key, sessionId: 'one', expiresAt: now + SESSION_GRANT_TTL });
  expect(store.find(request, 'other')).toBeUndefined(); expect(fs.existsSync(file())).toBe(false);
});

it('rejects a cached grant revoked during gate checks and redacts secret-bearing gate errors', async () => {
  const request = describeApproval(call, cwd), grant = store.grant(request, 'project');
  vi.spyOn(hooks, 'checkHooksAllow').mockResolvedValueOnce({ allowed: true }).mockImplementationOnce(async () => {
    store.revoke(request.projectKey, grant.id); return { allowed: true };
  });
  expect(await resolvePermission(call, context())).toMatchObject({ decision: 'deny', reason: expect.stringContaining('revoked') });
  const secret = 'sk-' + 'x'.repeat(40), log = RunLog.open('redacted-approval', { dir: join(root, 'logs') });
  vi.mocked(hooks.checkHooksAllow).mockRejectedValue(new Error('failure ' + secret));
  const result = await resolvePermission(call, { ...context(), audit: event => log.policyEvent(event) });
  expect(result).toMatchObject({ decision: 'deny', reason: expect.stringContaining('[REDACTED]') });
  log.policyEvent({ tool: 'write_file', decision: 'deny', source: 'hook', reason: secret, durationMs: 0 }); await log.flush();
  expect(fs.readFileSync(log.filePath, 'utf8')).not.toContain(secret);
});

it('rejects changed directory identity or symlink targets while an approval is pending', async () => {
  const other = join(root, 'other'); fs.mkdirSync(other);
  fs.symlinkSync(join(cwd, 'target.txt'), join(cwd, 'alias')); fs.writeFileSync(join(cwd, 'target.txt'), 'first');
  const aliased = { ...call, arguments: { path: 'alias', content: 'x' } };
  expect(await resolvePermission(aliased, { ...context(), approve: async () => {
    fs.unlinkSync(join(cwd, 'alias')); fs.writeFileSync(join(cwd, 'another.txt'), 'second'); fs.symlinkSync(join(cwd, 'another.txt'), join(cwd, 'alias')); return 'allow';
  } })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('changed') });
  const before = projectIdentity(cwd);
  fs.renameSync(cwd, join(root, 'moved')); fs.mkdirSync(cwd);
  expect(projectIdentity(cwd).projectKey).not.toBe(before.projectKey);
});

it('cancels pending approvals and never creates a grant or bypasses a subsequent gate denial', async () => {
  const controller = new AbortController(); let answer!: (value: ApprovalChoice) => void;
  const task = resolvePermission(call, { ...context(), signal: controller.signal, approve: () => new Promise(resolve => { answer = resolve; }) });
  await vi.waitFor(() => expect(answer).toBeTypeOf('function')); controller.abort();
  await expect(task).rejects.toMatchObject({ name: 'AbortError' }); answer('allow_project'); await Promise.resolve(); expect(fs.existsSync(file())).toBe(false);
  vi.spyOn(hooks, 'checkHooksAllow').mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, reason: 'late denial' });
  expect(await resolvePermission(call, { ...context(), approve: async () => 'allow_project' })).toMatchObject({ decision: 'deny', layer: 'hook' });
  expect(fs.existsSync(file())).toBe(false);
});

it('records grant IDs and expiry in a verifiable content-free permission audit', async () => {
  const log = RunLog.open('approval-fixture', { dir: join(root, 'logs') });
  const opts = { ...context(), audit: (event: Parameters<RunLog['policyEvent']>[0]) => log.policyEvent(event) };
  await resolvePermission(call, { ...opts, approve: async () => 'allow_project' });
  await resolvePermission(call, opts); await log.flush();
  const events = readRunLog(log.filePath); expect(verifyChain(events).ok).toBe(true);
  const grants = events.filter(event => event.grantId); expect(grants).toHaveLength(2);
  expect(grants[0]!.grantId).toBe(grants[1]!.grantId); expect(grants[0]!.grantExpiresAt).toBeGreaterThan(now);
  expect(JSON.stringify(events)).not.toContain('private-fixture-content');
});

it('bounds malformed inputs and rejects lossy JSON and invalid paths', () => {
  for (const value of [() => {}, NaN, BigInt(1), new Date(), { data: new Set() }]) expect(() => canonicalJson(value)).toThrow(ApprovalError);
  const loop: any = {}; loop.loop = loop; expect(() => canonicalJson(loop)).toThrow();
  expect(() => canonicalJson('x'.repeat(16 * 1024 * 1024 + 1))).toThrow(/16 MiB/);
  expect(() => canonicalJson({ ['x'.repeat(16 * 1024 * 1024 + 1)]: true })).toThrow(/16 MiB/);
  expect(() => canonicalJson('\0'.repeat(3 * 1024 * 1024))).toThrow(/16 MiB/);
  expect(() => canonicalPath('\0')).toThrow(); expect(() => describeApproval({ ...call, name: '\n' }, cwd)).toThrow();
  fs.symlinkSync(join(root, 'missing'), join(cwd, 'dangling')); expect(() => canonicalPath(join(cwd, 'dangling'))).toThrow();
});

it.each(['{', '{}', '[]', 'null', '{"version":2,"events":[]}'])('preserves malformed history and fails closed: %s', raw => {
  fs.mkdirSync(store.dir); fs.writeFileSync(file(), raw, { mode: 0o600 });
  expect(() => store.list(projectIdentity(cwd).projectKey)).toThrow(/damaged/);
  expect(() => store.grant(describeApproval(call, cwd), 'project')).toThrow(/damaged/);
  expect(fs.readFileSync(file(), 'utf8')).toBe(raw);
});

it('validates schema and hash links, including rehashed records with unauthorized fields', () => {
  const request = describeApproval(call, cwd); store.grant(request, 'project');
  const original = JSON.parse(fs.readFileSync(file(), 'utf8'));
  for (const mutate of [
    (v: any) => { v.events[0].change.grant.key = 'bad'; },
    (v: any) => { v.events[0].change.grant.scope = 'session'; },
    (v: any) => { v.events[0].change.grant.rawArguments = 'no'; },
    (v: any) => { v.events[0].change.grant.expiresAt = now + PROJECT_GRANT_TTL + 1; },
    (v: any) => { v.events[0].at = v.events[0].change.grant.createdAt = 8640000000000001; v.events[0].change.grant.expiresAt = 8640000000000002; },
    (v: any) => { v.events[0].previous = 'broken'; },
    (v: any) => { v.events[0].id = v.events[0].change.grant.id = '-'.repeat(36); },
  ]) {
    const value = structuredClone(original); mutate(value); const { hash: _hash, ...body } = value.events[0]; value.events[0].hash = digest(canonicalJson(body));
    fs.writeFileSync(file(), JSON.stringify(value)); expect(() => store.find(request)).toThrow(/damaged/);
  }
  original.events[0].hash = 'wrong'; fs.writeFileSync(file(), JSON.stringify(original)); expect(() => store.find(request)).toThrow(/damaged/);
});

it('refuses symlink/unsafe stores, file types, oversized files and a live writer lock', () => {
  const request = describeApproval(call, cwd);
  fs.mkdirSync(store.dir); fs.symlinkSync(join(root, 'outside'), file());
  expect(() => store.grant(request, 'project')).toThrow(); fs.unlinkSync(file());
  fs.writeFileSync(file() + '.lock', 'other writer');
  expect(() => store.grant(request, 'project')).toThrow(/another writer/); expect(fs.readFileSync(file() + '.lock', 'utf8')).toBe('other writer'); fs.unlinkSync(file() + '.lock');
  const fd = fs.openSync(file(), 'w', 0o600); fs.ftruncateSync(fd, MAX_APPROVAL_BYTES + 1); fs.closeSync(fd);
  expect(() => store.find(request)).toThrow(/damaged/); fs.unlinkSync(file());
  fs.chmodSync(store.dir, 0o777); expect(() => store.list(request.projectKey)).toThrow(/damaged/); fs.chmodSync(store.dir, 0o700);
  fs.rmdirSync(store.dir); fs.symlinkSync(cwd, store.dir); expect(() => store.grant(request, 'project')).toThrow(/damaged/);
});

it('keeps the old committed record and removes only its own temporary files after failed I/O', () => {
  const request = describeApproval(call, cwd); store.grant(request, 'project'); const before = fs.readFileSync(file(), 'utf8');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(() => store.grant(request, 'project')).toThrow('disk failure'); expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  expect(fs.readdirSync(store.dir)).toEqual(['history.json']);
  expect(() => store.grant(request, 'project', undefined, AbortSignal.abort())).toThrow(/cancelled/);
  expect(fs.readFileSync(file(), 'utf8')).toBe(before);
});

it('disables reuse at the history limit while preserving records and allowing a final revocation', () => {
  const request = describeApproval(call, cwd); store.grant(request, 'project');
  const value = JSON.parse(fs.readFileSync(file(), 'utf8')), original = value.events[0];
  for (let index = 1; index < MAX_APPROVAL_EVENTS - 1; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const body = { version: 1, id, at: now, previous: value.events.at(-1).hash, change: { type: 'reset', projectKey: digest('other project') } };
    value.events.push({ ...body, hash: digest(canonicalJson(body)) });
  }
  fs.writeFileSync(file(), JSON.stringify(value));
  expect(store.list(request.projectKey)).toMatchObject({ events: 4999, disabled: true }); expect(store.find(request)).toBeUndefined();
  expect(() => store.grant(request, 'project')).toThrow(/limit/);
  expect(() => store.grant(request, 'session', 'one')).toThrow(/limit/);
  store.revoke(request.projectKey); expect(store.list(request.projectKey).grants).toEqual([]);
  expect(JSON.parse(fs.readFileSync(file(), 'utf8')).events[0]).toEqual(original);
});

it('serializes parallel prompts, ignores stale replies and cleans cancelled queued requests', async () => {
  let pending: PendingApproval | null = null; const queue = new ApprovalQueue(value => { pending = value; });
  const request = describeApproval(call, cwd), a = new AbortController(), b = new AbortController();
  const first = queue.request(request, a.signal), firstId = pending!.id;
  const second = queue.request(request, b.signal); expect(pending!.queued).toBe(1);
  b.abort(); expect(await second).toBe('cancelled'); expect(pending!.id).toBe(firstId);
  queue.answer(firstId, 'allow_session'); expect(await first).toBe('allow_session'); expect(pending).toBeNull();
  const third = queue.request(request); const thirdId = pending!.id; queue.answer(firstId, 'allow'); expect(pending!.id).toBe(thirdId);
  queue.cancel(); expect(await third).toBe('cancelled'); expect(pending).toBeNull();
  expect(await queue.request(request, AbortSignal.abort())).toBe('cancelled');
  const batch = Array.from({ length: 100 }, () => queue.request(request)); expect(await queue.request(request)).toBe('reject');
  queue.cancel(); expect((await Promise.all(batch)).every(choice => choice === 'cancelled')).toBe(true);
});

it('rejects reusable replies for a one-time-only queue operation', async () => {
  let pending: PendingApproval | null = null; const queue = new ApprovalQueue(value => { pending = value; });
  const task = queue.request(describeApproval({ ...call, name: 'shell', arguments: { command: 'npm publish' } }, cwd));
  queue.answer(pending!.id, 'allow_project'); expect(pending).not.toBeNull(); queue.answer(pending!.id, 'reject'); expect(await task).toBe('reject');
});

it('provides local-only headless inspection/revocation JSON and safe error contracts', async () => {
  const request = describeApproval(call, cwd), grant = store.grant(request, 'project');
  const opts = { cwd, store, sessionId: 'one' }, output: string[] = [];
  expect(await runPermissions(['list', '--json'], { ...opts, write: text => output.push(text) })).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({ version: 1, type: 'permissions', localOnly: true, grants: [{ id: grant.id }] });
  expect(await permissionsCommand(['revoke', grant.id], opts)).toMatchObject({ exitCode: 0, report: { grants: [] } });
  store.grant(request, 'session', 'one'); expect(await permissionsCommand(['reset'], opts)).toMatchObject({ exitCode: 0, report: { grants: [] } });
  for (const args of [['bad'], ['revoke'], ['list', '--unknown'], ['list', 'extra']]) expect(await permissionsCommand(args, opts)).toMatchObject({ exitCode: 2, report: { error: { code: 'invalid-arguments' } } });
  expect(await permissionsCommand([], { ...opts, signal: AbortSignal.abort() })).toMatchObject({ exitCode: 130 });
  fs.writeFileSync(file(), 'private-malformed-marker');
  const bad = await permissionsCommand([], opts); expect(bad).toMatchObject({ exitCode: 1, report: { error: { code: 'records-unavailable' } } }); expect(JSON.stringify(bad)).not.toContain('private-malformed-marker');
});

it('blocks an agent path alias into its protected local approval authority even if scope is extended', async () => {
  const { homedir } = await import('node:os'); const protectedDir = join(homedir(), '.calliope-cli', 'approvals'); fs.mkdirSync(protectedDir, { recursive: true });
  fs.symlinkSync(protectedDir, join(cwd, 'alias')); scopeManager.addDirectory(protectedDir);
  const result = await executeTool({ ...call, arguments: { path: 'alias/forged.json', content: '{}' } }, cwd);
  expect(result.isError).toBe(true); expect(result.result).toContain('state directory'); expect(fs.existsSync(join(protectedDir, 'forged.json'))).toBe(false);
});

it.skipIf(process.platform !== 'darwin')('denies sandboxed reads and writes of approval history despite an explicit extra writable path', async () => {
  const { homedir } = await import('node:os'), authority = join(homedir(), '.calliope-cli', 'approvals');
  fs.mkdirSync(authority, { recursive: true }); const target = join(authority, 'sandbox-fixture.txt'); fs.writeFileSync(target, 'authority');
  const profile = buildSeatbeltProfile(cwd, { readWritePaths: [authority] });
  try {
    expect(() => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', target], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', 'echo changed > "$1"', 'sandbox-test', target], { stdio: 'pipe' })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('authority');
    expect(execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/echo', 'allowed'], { encoding: 'utf8' })).toBe('allowed\n');
  } finally { fs.unlinkSync(target); }
});
