import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parse } from "yaml";
const workflow = (file: string) =>
  parse(
    readFileSync(
      new URL(`../.github/workflows/${file}.yml`, import.meta.url),
      "utf8",
    ),
  );
it("requires the shared publication gate before npm or binary promotion", () => {
  const checks = workflow("release-checks").jobs.checks.steps;
  expect(
    checks.filter((s: any) => s.run === "npm run test:conformance:release"),
  ).toEqual([expect.objectContaining({ if: "${{ !inputs.preview }}" })]);
  for (const command of [
    "npx tsc --noEmit",
    "npm test -- --maxWorkers=2",
    "npm run test:coverage -- --maxWorkers=2",
    "npm run test:conformance",
    "npm run build",
    "npm run bench",
  ])
    expect(checks.some((s: any) => s.run === command)).toBe(true);
  const npm = workflow("publish");
  expect(npm.jobs.checks.uses).toBe("./.github/workflows/release-checks.yml");
  expect(npm.jobs.checks.with?.preview).not.toBe(true);
  expect(npm.jobs.publish.needs).toBe("checks");
  const runs = npm.jobs.publish.steps.map((s: any) => s.run ?? "").join("\n");
  expect(runs.match(/npm publish --provenance --access public/g)).toHaveLength(
    2,
  );
  expect(runs).not.toMatch(/npm version|git push|git clean/);
  const binary = workflow("release-binaries");
  expect(binary.jobs.build.needs).toBe("checks");
  expect(binary.jobs.assemble.needs).toEqual(["checks", "build"]);
  expect(binary.jobs.checks.with.preview).toBe(
    "${{ github.event_name == 'workflow_dispatch' }}",
  );
  const upload = binary.jobs.assemble.steps.find((s: any) =>
    s.run?.includes("gh release upload"),
  );
  expect(upload.if).toBe("github.event_name == 'release'");
  expect(upload.run).not.toContain("--clobber");
});
it("attests and verifies every native binary and the complete checksum manifest", () => {
  const jobs = workflow("release-binaries").jobs;
  expect(
    jobs.build.strategy.matrix.include.map((v: any) => v.asset).sort(),
  ).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64"]);
  expect(jobs.build.strategy.matrix.include).toContainEqual({
    target: "bun-windows-x64",
    asset: "win-x64",
    os: "windows-2025",
    exe: ".exe",
  });
  expect(jobs.build.defaults.run.shell).toBe("bash");
  expect(jobs.build.strategy.matrix.include.map((v: any) => v.os)).toContain(
    "ubuntu-24.04-arm",
  );
  expect(jobs.build.strategy.matrix.include.map((v: any) => v.os)).toContain(
    "macos-15-intel",
  );
  for (const job of [jobs.build, jobs.assemble]) {
    expect(job.permissions["id-token"]).toBe("write");
    expect(job.permissions.attestations).toBe("write");
    expect(
      job.steps.some((s: any) =>
        /^actions\/attest@[a-f0-9]{40}$/.test(s.uses ?? ""),
      ),
    ).toBe(true);
    const verification = job.steps
      .filter((s: any) => s.run?.includes("gh attestation verify"))
      .map((s: any) => s.run)
      .join("\n");
    for (const flag of [
      "--bundle",
      "--repo calliopeai/calliope-cli",
      "--source-ref",
      "--source-digest",
      "--cert-identity",
      "--deny-self-hosted-runners",
    ])
      expect(verification).toContain(flag);
    expect(verification).not.toContain("--signer-workflow");
    expect(verification).toContain(
      "https://github.com/calliopeai/calliope-cli/.github/workflows/release-binaries.yml@$SOURCE_REF",
    );
  }
  expect(
    jobs.build.steps.some((s: any) =>
      s.run?.includes("scripts/release/binary-smoke.mjs"),
    ),
  ).toBe(true);
  expect(
    jobs.assemble.steps.some((s: any) =>
      s.run?.includes("scripts/release/assemble.mjs"),
    ),
  ).toBe(true);
  expect(
    jobs.assemble.steps
      .filter((s: any) => s.uses?.startsWith("actions/attest@"))
      .map((s: any) => s.with["subject-path"]),
  ).toEqual(["out/checksums.txt", "out/calliope-binaries.json"]);
  const manifests = jobs.assemble.steps.find(
    (s: any) => s.name === "Retain and verify manifest provenance",
  );
  expect(manifests.run).toContain(
    "for manifest in out/checksums.txt out/calliope-binaries.json",
  );
});
it("signs and notarises macOS binaries before the smoke test, checksum and attestation", () => {
  const steps = workflow("release-binaries").jobs.build.steps;
  const at = (name: string) => steps.findIndex((s: any) => s.name === name);
  const order = [
    "Compile the native artifact",
    "Require signing credentials for a macOS release",
    "Sign the macOS binary with the hardened runtime",
    "Notarise the macOS binary",
    "Smoke-test and stage the bytes that ship",
    "Attest the binary",
  ].map(at);
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const gate = steps[at("Require signing credentials for a macOS release")];
  expect(gate.if).toBe("runner.os == 'macOS'");
  for (const name of ["Sign the macOS binary with the hardened runtime", "Notarise the macOS binary"])
    expect(steps[at(name)].if).toBe("steps.signing.outputs.sign == 'true'");
  const sign = steps[at("Sign the macOS binary with the hardened runtime")].run;
  expect(sign).toContain("codesign --force --timestamp --options runtime --entitlements packaging/entitlements.plist");
  expect(sign).toContain("codesign --verify --strict");
  const notarise = steps[at("Notarise the macOS binary")].run;
  expect(notarise).toContain("xcrun notarytool submit");
  expect(notarise).toContain("--wait");
  expect(notarise).toContain('if [ "$status" != Accepted ]; then');
  expect(steps[at("Remove the signing keychain")].if).toBe("always() && steps.signing.outputs.sign == 'true'");
  expect(steps[at("Smoke-test and stage the bytes that ship")].run).toContain("scripts/release/checksum.mjs");
  // Secrets arrive only through step env, never interpolated into a script.
  for (const step of steps) expect(step.run ?? "").not.toContain("secrets.");
  const entitlements = readFileSync(new URL("../packaging/entitlements.plist", import.meta.url), "utf8");
  expect(entitlements).toContain("<key>com.apple.security.cs.allow-jit</key>");
});
it.each([
  ["release", true, 0, "sign=true"],
  ["workflow_dispatch", true, 0, "sign=true"],
  ["workflow_dispatch", false, 0, "sign=false"],
  ["release", false, 1, ""],
])("the macOS signing gate on %s with secrets=%s exits %i", (event, secrets, code, output) => {
  const gate = workflow("release-binaries").jobs.build.steps.find(
    (s: any) => s.name === "Require signing credentials for a macOS release",
  );
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
    expect(gate.env[name]).toBe(`\${{ secrets.${name} }}`);
  const root = mkdtempSync(join(tmpdir(), "signing-gate-"));
  try {
    const values = Object.fromEntries(Object.keys(gate.env).map((name) => [name, secrets ? "present" : ""]));
    const result = spawnSync("bash", ["-e", "-c", gate.run], {
      env: { PATH: process.env.PATH, ...values, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: join(root, "output") },
      encoding: "utf8",
    });
    expect(result.status).toBe(code);
    expect(result.stdout).toContain(code ? "::error title=Unsigned macOS release::" : secrets ? "" : "::warning title=Unsigned macOS preview::");
    expect(code ? "" : readFileSync(join(root, "output"), "utf8").trim()).toBe(output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("builds certified container tags only from the successful npm publisher source", () => {
  const image = workflow("build");
  expect(image.on.workflow_run.workflows).toEqual(["Publish to npm"]);
  expect(image.on.workflow_dispatch?.inputs?.tag_stable).toBeUndefined();
  const job = image.jobs["build-and-push"];
  expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(job.steps[0].with.ref).toBe(
    "${{ github.event.workflow_run.head_sha || github.sha }}",
  );
  expect(job.steps.find((s: any) => s.name === "Tag :stable").if).toContain(
    "github.event_name == 'workflow_run'",
  );
  expect(job.steps.find((s: any) => s.name === "Tag :stable").if).toContain(
    "github.event_name == 'workflow_dispatch'",
  );
  const tags = job.steps.find((s: any) => s.name === "Build and push image")
    .with.tags;
  expect(tags).toContain("github.event_name == 'workflow_run' || github.event_name == 'workflow_dispatch'");
});
