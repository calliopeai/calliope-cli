/** Publication identity, without modifying a version, branch or tag. */
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
export function releaseSource(version, env, head, tagCommit, preview = false) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/.test(
      version,
    ) ||
    version.length > 127
  )
    throw new Error("Invalid release version");
  if (
    env.GITHUB_REPOSITORY !== "calliopeai/calliope-cli" ||
    !/^[a-f0-9]{40}$/.test(head) ||
    env.GITHUB_SHA !== head
  )
    throw new Error("Checkout does not match the workflow source identity");
  if (preview) {
    if (
      env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      env.GITHUB_REF !== "refs/heads/main"
    )
      throw new Error("Binary previews require a manual main-branch run");
  } else if (
    !["release", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF !== `refs/tags/v${version}` ||
    tagCommit !== head
  ) {
    throw new Error(
      "Publication requires the exact existing package version tag and commit",
    );
  }
  return {
    version,
    tag: `v${version}`,
    sha: head,
    ref: env.GITHUB_REF,
    preview,
    prerelease: version.includes("-"),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const preview = process.argv[2] === "--preview";
  if (process.argv.length > (preview ? 3 : 2))
    throw new Error("Invalid release source arguments");
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const tagCommit = preview
    ? undefined
    : execFileSync(
        "git",
        ["rev-parse", "--verify", `refs/tags/v${version}^{commit}`],
        { encoding: "utf8" },
      ).trim();
  const result = releaseSource(version, process.env, head, tagCommit, preview);
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(result))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(JSON.stringify(result));
}
