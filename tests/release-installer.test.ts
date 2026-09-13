import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
const installer = new URL("../install.sh", import.meta.url).pathname;
const wrapper = new URL("../packaging/install.sh", import.meta.url).pathname;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "calliope-install-'quoted-")),
    tools = join(root, "tools"),
    files = join(root, "files"),
    dest = join(root, "dest"),
    temp = join(root, "temp");
  for (const dir of [tools, files, dest, temp]) mkdirSync(dir);
  const asset = "calliope-3.2.0-linux-x64",
    binary = "new verified fixture\n",
    hash = createHash("sha256").update(binary).digest("hex"),
    sha = "a".repeat(40);
  writeFileSync(join(files, asset), binary);
  writeFileSync(join(files, "checksums.txt"), `${hash}  ${asset}\n`);
  for (const name of [asset, "checksums.txt"])
    writeFileSync(
      join(files, name + ".sigstore.json"),
      JSON.stringify({
        sha,
        tag: "v3.2.0",
        digest: createHash("sha256")
          .update(readFileSync(join(files, name)))
          .digest("hex"),
      }),
    );
  const shim = `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),crypto=require('crypto');const args=process.argv.slice(2),root=process.env.FIXTURE_ROOT,name=path.basename(process.argv[1]);fs.appendFileSync(path.join(root,'calls'),JSON.stringify({name,args})+'\\n');
const value=flag=>args[args.indexOf(flag)+1];
if(name==='uname'){console.log(args[0]==='-s'?'Linux':'x86_64');process.exit(0);}
if(name==='curl'){if(!args.includes('--max-time')||value('--retry')!=='0'||value('--proto')!=='=https'||value('--proto-redir')!=='=https')process.exit(9);const url=args.find(a=>a.startsWith('https://'));const input=path.join(root,'files',url.split('/').at(-1));if(!fs.existsSync(input))process.exit(22);fs.copyFileSync(input,value('--output'));process.exit(0);}
if(name==='gh'&&args[0]==='api'){console.log(args[1].endsWith('/latest')?'v3.2.0':'a'.repeat(40));process.exit(0);}
if(name==='gh'&&args[0]==='attestation'&&args[1]==='verify'){
// Real gh rejects combinations of these mutually exclusive identity selectors.
if(['--cert-identity','--cert-identity-regex','--signer-repo','--signer-workflow'].filter(flag=>args.includes(flag)).length>1)process.exit(2);
const bundle=JSON.parse(fs.readFileSync(value('--bundle')));const signer='calliopeai/calliope-cli/.github/workflows/release-binaries.yml';
const good=value('--repo')==='calliopeai/calliope-cli'&&value('--source-ref')==='refs/tags/'+bundle.tag&&value('--source-digest')===bundle.sha&&value('--cert-identity')==='https://github.com/'+signer+'@refs/tags/'+bundle.tag&&args.includes('--deny-self-hosted-runners')&&bundle.digest===crypto.createHash('sha256').update(fs.readFileSync(args[2])).digest('hex');process.exit(good?0:1);}
process.exit(8);
`;
  for (const tool of ["gh", "curl", "uname"])
    writeFileSync(join(tools, tool), shim, { mode: 0o755 });
  writeFileSync(join(dest, "calliope"), "existing user install\n");
  return {
    root,
    files,
    dest,
    temp,
    asset,
    binary,
    env: {
      ...process.env,
      PATH: tools + ":" + process.env.PATH,
      FIXTURE_ROOT: root,
      TMPDIR: temp,
      CALLIOPE_VERSION: "v3.2.0",
      CALLIOPE_INSTALL_DIR: dest,
    },
  };
}
it.each([installer, wrapper])(
  "verifies the complete policy before atomically replacing an existing install via %s",
  (script) => {
    const f = fixture();
    try {
      const result = spawnSync("bash", [script], {
        env: f.env,
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.dest, "calliope"), "utf8")).toBe(f.binary);
      const calls = readFileSync(join(f.root, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.filter((c) => c.name === "gh" && c.args[0] === "attestation"),
      ).toHaveLength(2);
      expect(readdirSync(f.temp)).toEqual([]);
      expect(readdirSync(f.dest)).toEqual(["calliope"]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
it.each([
  "missing-checksums",
  "missing-bundle",
  "bad-checksum",
  "bad-manifest-signature",
  "wrong-source",
  "duplicate-checksum",
  "missing-entry",
  "invalid-tag",
])("preserves the old installation on %s", (mode) => {
  const f = fixture();
  try {
    if (mode === "missing-checksums") rmSync(join(f.files, "checksums.txt"));
    if (mode === "missing-bundle")
      rmSync(join(f.files, f.asset + ".sigstore.json"));
    if (mode === "bad-checksum")
      writeFileSync(join(f.files, f.asset), "tampered bytes");
    if (mode === "bad-manifest-signature")
      writeFileSync(join(f.files, "checksums.txt.sigstore.json"), "{}");
    if (mode === "wrong-source") {
      const p = join(f.files, f.asset + ".sigstore.json"),
        b = JSON.parse(readFileSync(p, "utf8"));
      b.sha = "b".repeat(40);
      writeFileSync(p, JSON.stringify(b));
    }
    if (["duplicate-checksum", "missing-entry"].includes(mode)) {
      const p = join(f.files, "checksums.txt");
      writeFileSync(
        p,
        mode === "duplicate-checksum"
          ? readFileSync(p, "utf8").repeat(2)
          : "a".repeat(64) + "  unrelated\n",
      );
      const b = join(f.files, "checksums.txt.sigstore.json"),
        v = JSON.parse(readFileSync(b, "utf8"));
      v.digest = createHash("sha256").update(readFileSync(p)).digest("hex");
      writeFileSync(b, JSON.stringify(v));
    }
    if (mode === "invalid-tag")
      f.env.CALLIOPE_VERSION = "v3.2.0;touch injected";
    const result = spawnSync("bash", [installer], {
      env: f.env,
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.dest, "calliope"), "utf8")).toBe(
      "existing user install\n",
    );
    expect(readdirSync(f.temp)).toEqual([]);
    expect(existsSync(join(f.root, "injected"))).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
