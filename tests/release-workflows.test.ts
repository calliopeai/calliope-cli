import { readFileSync } from "node:fs";
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
  ).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
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
  expect(job.steps.find((s: any) => s.name === "Tag :stable").if).toBe(
    "github.event_name == 'workflow_run'",
  );
  const tags = job.steps.find((s: any) => s.name === "Build and push image")
    .with.tags;
  expect(tags).toContain("github.event_name == 'workflow_run' && format");
});
