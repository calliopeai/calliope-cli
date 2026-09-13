/** Exercise the actual executable from an unrelated working directory, without inference. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
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
const run = (args) =>
  execFileSync(binary, args, {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
try {
  assert.ok(run(["--version"]).includes(`v${version}`));
  const doctor = JSON.parse(run(["doctor", "--json"]));
  assert.equal(doctor.version, 1);
  assert.equal(doctor.localOnly, true);
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
      doctor: true,
      brainIndexedSearch: true,
      inferenceRequests: 0,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
