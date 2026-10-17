# Pinned migration inventory

`calliope migration inventory` captures deterministic input evidence for migration
assessment. It reads a full immutable Git commit in a local repository, including
committed files that differ from the current working tree. Dirty and untracked
files are neither included nor changed. It performs no provider inference, package
installation, repository script execution or migration dispatch.

```sh
calliope migration capabilities --json
calliope migration schema --json
calliope migration inventory --repository /path/to/repository --revision FULL_COMMIT_ID --json
calliope migration inventory --repository /path/to/repository --revision FULL_COMMIT_ID --path packages/app --json
```

The selected path must be the root of a complete local clone; repositories with
partial-clone/promisor configuration are refused before object lookup, including
on Git versions that ignore the no-lazy-fetch environment setting.
Revision expressions, branches,
annotated-tag objects and abbreviated hashes are refused; resolve the intended
commit before invoking the command. Repeated `--path` options select literal
repository-relative prefixes, not globs. Library callers use `inventorySource`
with explicit `readPaths` and an optional abort signal. Hosts must supply the read
scope already authorized for the task; this library does not grant access.

The `calliope.migration.inventory/v1` artifact contains:

- Exact commit/tree identities and read scope, plus every included tracked file's
  object identity, mode, byte count and observed surface category.
- Parsed `package.json` names, build/test script **names**, and declared dependency
  sections. Scripts and credential-bearing URL specs never enter the report.
  Specs retain a digest; ordinary registry ranges/tags can be displayed.
- Candidate local package edges for supported `workspace:` name declarations and
  relative `file:` declarations, dependency-first ordering, or exact cycle
  components. Ambiguous names, unsupported aliases and missing/out-of-scope
  targets remain unresolved. The graph is not proof of package-manager resolution,
  workspace membership or source-level import dependencies.
- Explicit findings for malformed/oversized manifests, opaque dependency specs,
  unsupported dependency formats, symlinks and submodules. Links are recorded but
  never traversed, and Git replacement objects are disabled.
- A SHA-256 digest of the canonical artifact body, excluding `digest` itself.
  The kit version, source identities, scope, declarations and limitations are bound
  into that digest. No timestamp or machine-specific repository path affects it.

`schema` returns the packaged JSON Schema locally; its `$id` is an artifact
identifier and requires no network lookup. JSON errors have a bounded code/message
and omit raw Git errors, commands and repository arguments. Cancellation returns
exit code 130; other refusals return 1.

One observation is bounded to 30 seconds, 5,000 entries, 128 parsed npm manifests,
256 KiB per manifest, 4 MiB of manifest bytes and 2,048 declared dependencies.
The shared Git runner also bounds each command's time/output and disables lazy
network fetching. Narrow the read scope when those limits prevent observation.

This is the inventory phase of the shared migration kit (#414), supporting
Cykick's assessment/execution work (#42/#43). It does not establish a behavioral
baseline, detect dynamic imports, test installability, estimate migration cost,
recommend a language adapter, approve compatibility exceptions or authorize
workers. Those conclusions require their own evidence and reviewed contracts.
