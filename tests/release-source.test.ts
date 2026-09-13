import { expect, it } from "vitest";
import { releaseSource } from "../scripts/release/source.mjs";
const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "calliopeai/calliope-cli",
  GITHUB_EVENT_NAME: "release",
  GITHUB_REF: "refs/tags/v3.2.0",
  GITHUB_SHA: sha,
};
it("accepts only an existing matching version tag and exact workflow checkout", () => {
  expect(releaseSource("3.2.0", env, sha, sha)).toMatchObject({
    tag: "v3.2.0",
    sha,
    preview: false,
    prerelease: false,
  });
  expect(
    releaseSource(
      "3.2.0-alpha.1",
      {
        ...env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/tags/v3.2.0-alpha.1",
      },
      sha,
      sha,
    ).prerelease,
  ).toBe(true);
});
it.each([
  ["version", "3.2.1", env, sha, sha],
  ["command", "3.2.0;echo pwned", env, sha, sha],
  ["branch", "3.2.0", { ...env, GITHUB_REF: "refs/heads/main" }, sha, sha],
  ["tag moved", "3.2.0", env, sha, "b".repeat(40)],
  ["checkout changed", "3.2.0", env, "b".repeat(40), sha],
  [
    "foreign repo",
    "3.2.0",
    { ...env, GITHUB_REPOSITORY: "other/repo" },
    sha,
    sha,
  ],
  ["push", "3.2.0", { ...env, GITHUB_EVENT_NAME: "push" }, sha, sha],
])("refuses publication on %s", (_name, version, input, head, tag) => {
  expect(() => releaseSource(version, input, head, tag)).toThrow();
});
it("permits only explicitly dispatched main previews, which remain marked as previews", () => {
  expect(
    releaseSource(
      "3.2.0",
      {
        ...env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/main",
      },
      sha,
      undefined,
      true,
    ).preview,
  ).toBe(true);
  expect(() => releaseSource("3.2.0", env, sha, sha, true)).toThrow();
  expect(() =>
    releaseSource(
      "3.2.0",
      {
        ...env,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/feature",
      },
      sha,
      sha,
      true,
    ),
  ).toThrow();
});
