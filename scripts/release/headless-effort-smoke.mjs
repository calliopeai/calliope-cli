/** The exact Node or native executable against a synthetic local Anthropic SDK transport. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

function kill(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function qualifyHeadlessEffort(executable, prefix, parent) {
  const root = join(parent, 'headless-effort');
  let supported = true, requests = [], fixtureError;
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        assert.ok(['/v1/models', '/v1/models/effort-fixture'].includes(request.url));
        const model = { id: 'effort-fixture', max_input_tokens: 32768, max_tokens: 1024,
          capabilities: { effort: { supported: true, medium: { supported } } } };
        response.end(JSON.stringify(request.url === '/v1/models' ? { data: [model], has_more: false } : model));
        return;
      }
      assert.equal(request.url, '/v1/messages');
      assert.equal(request.headers.authorization, 'Bearer native-effort-fixture-key');
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.model, 'effort-fixture');
      assert.deepEqual(body.output_config, { effort: 'medium' });
      const first = requests.length === 0;
      if (first) assert.equal(body.messages[0].content, 'Read fixture.txt and report its text.');
      requests.push(body);
      response.end(JSON.stringify({ id: 'effort-response', type: 'message', role: 'assistant', model: body.model,
        content: first ? [{ type: 'tool_use', id: 'effort-read', name: 'read_file', input: { path: 'fixture.txt' } }]
          : [{ type: 'text', text: 'Effort fixture completed.' }],
        stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }));
    } catch (error) {
      fixtureError = error; response.statusCode = 400; response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const cases = [
      { name: 'flag', flags: ['--reasoning-effort', 'medium'], environment: 'high', supported: true },
      { name: 'environment', flags: [], environment: 'medium', supported: true },
      { name: 'unsupported', flags: ['--reasoning-effort=medium'], environment: '', supported: false },
      { name: 'invalid', flags: ['--reasoning-effort', 'invented'], environment: '', supported: true },
    ];
    for (const scenario of cases) {
      supported = scenario.supported; requests = []; fixtureError = undefined;
      const home = join(root, scenario.name), project = join(home, 'project'), config = join(home, 'config');
      await mkdir(project, { recursive: true }); await mkdir(config);
      await writeFile(join(project, 'fixture.txt'), 'native effort fixture\n');
      await writeFile(join(config, 'config.json'), JSON.stringify({ setupComplete: true, autoUpgrade: false,
        defaultProvider: 'anthropic', defaultModel: 'effort-fixture', maxIterations: 3, sandboxMode: 'off',
        providers: { anthropic: { apiKey: 'native-effort-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } },
        routing: { enabled: false }, audit: { enabled: false } }));
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|comspec|pathext|temp|tmp|windir)$/i.test(key))), HOME: home, USERPROFILE: home, NO_COLOR: '1',
        CALLIOPE_CONFIG_DIR: config, CALLIOPE_MAX_RETRIES: '0', CALLIOPE_REASONING_EFFORT: scenario.environment };
      const child = spawn(executable, [...prefix, '--headless', '--auto', '--json', '--provider', 'anthropic', '--model', 'effort-fixture',
        ...scenario.flags, 'Read fixture.txt and report its text.'], { cwd: project, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.stdin.end();
      const timer = setTimeout(() => { kill(child) }, 7000);
      try {
        const [code] = await once(child, 'exit');
        assert.ifError(fixtureError);
        if (scenario.name === 'invalid') assert.equal(code, 2, stdout + stderr);
        else if (!scenario.supported) assert.notEqual(code, 0, stdout + stderr);
        else {
          assert.equal(code, 0, stdout + stderr);
          assert.equal(requests.length, 2, 'both the initial and post-tool request must preserve effort');
          assert.match(stdout, /native effort fixture/);
        }
        if (!scenario.supported || scenario.name === 'invalid') assert.equal(requests.length, 0, stdout + stderr);
      } finally { clearTimeout(timer); if (child.pid) { kill(child); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); }; }
    }
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
