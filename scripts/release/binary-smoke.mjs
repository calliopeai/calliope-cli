/** Exercise the actual executable from an unrelated working directory, without inference. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@zed-industries/agent-client-protocol";
const binary = resolve(process.argv[2]),
  version = process.argv[3];
const root = mkdtempSync(join(tmpdir(), "calliope-binary-smoke-"));
const project = join(root, "project");
mkdirSync(project);
const env = {
  ...process.env,
  CALLIOPE_CONFIG_DIR: join(root, "config"),
  CALLIOPE_HEALTH_DIR: join(root, "health"),
};
const run = (args, expectedCode = 0) => {
  const result = spawnSync(binary, args, {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    expectedCode,
    `calliope ${args.join(" ")} exited ${result.status}\n${result.stdout.slice(0, 2000)}\n${result.stderr.slice(0, 2000)}`,
  );
  return result.stdout;
};
/** The handshake an embedding host performs over stdio before its first prompt. */
async function acpHandshake() {
  const home = join(root, "home");
  mkdirSync(home);
  const agent = spawn(binary, ["acp"], {
    cwd: project,
    env: { ...env, HOME: home, USERPROFILE: home },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise((done) => agent.once("exit", done));
  const within = (promise, step) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`ACP ${step} timed out`)), 30000).unref(),
      ),
    ]);
  try {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout)),
    );
    const initialized = await within(
      connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
      "initialize",
    );
    assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
    const session = await within(
      connection.newSession({ cwd: project, mcpServers: [] }),
      "session/new",
    );
    assert.match(session.sessionId, /^acp_/);
    agent.stdin.end();
    assert.equal(await within(exited, "shutdown"), 0);
  } finally {
    agent.kill();
  }
}
try {
  assert.ok(run(["--version"]).includes(`v${version}`));
  assert.deepEqual(JSON.parse(run(["--version", "--json"])), {
    version,
    acp: PROTOCOL_VERSION,
  });
  await acpHandshake();
  const doctor = JSON.parse(run(["doctor", "--json"]));
  assert.equal(doctor.version, 1);
  assert.equal(doctor.localOnly, true);
  // A full pipe must not truncate machine-readable output at process exit.
  // These primitive body keys are already in the run-log's canonical order.
  const body = {
    seq: 0,
    text: "Public output drain fixture. ".repeat(10000),
    ts: "2026-01-01T00:00:00.000Z",
    type: "user_prompt",
    v: 1,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  writeFileSync(
    join(project, "trace.jsonl"),
    JSON.stringify({ ...body, prev_hash: "", hash }) + "\n",
  );
  const replay = JSON.parse(run(["replay", "trace.jsonl", "--json"]));
  assert.equal(replay.verification.ok, true);
  assert.equal(replay.events[0].text, body.text);
  writeFileSync(
    join(project, "trace.jsonl"),
    JSON.stringify({ ...body, prev_hash: "", hash: "0".repeat(64) }) + "\n",
  );
  const invalid = JSON.parse(run(["replay", "trace.jsonl", "--json"], 4));
  assert.equal(invalid.verification.ok, false);
  assert.equal(invalid.events[0].text, body.text);
  const denied = JSON.parse(run(["brain", "init", "--json"], 3));
  assert.ok(denied.error);
  const initialized = JSON.parse(
    run(["brain", "init", "--allow-mutations", "--json"]),
  );
  assert.equal(initialized.type, "brain");
  assert.ok(initialized.data);
  assert.equal(initialized.error, undefined);
  writeFileSync(
    join(project, "source.md"),
    "Release package indexed evidence.\n",
  );
  const ingested = JSON.parse(
    run(["brain", "ingest", "source.md", "--allow-mutations", "--json"]),
  );
  assert.equal(ingested.type, "brain");
  assert.ok(ingested.data.entityId);
  assert.equal(ingested.error, undefined);
  const found = JSON.parse(run(["brain", "search", "indexed", "--json"]));
  assert.equal(found.data.entities.length, 1);
  console.log(
    JSON.stringify({
      version: 1,
      passed: true,
      packageVersion: version,
      versionJson: true,
      acpHandshake: true,
      doctor: true,
      brainIndexedSearch: true,
      completeLargeJson: true,
      failureAndDenialExitCodes: true,
      inferenceRequests: 0,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
