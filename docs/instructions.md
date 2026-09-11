# Repository instructions

Use `AGENTS.md` for instructions shared across coding agents. Keep project
reference material and learned preferences in `CALLIOPE.md`. Both feed the
shared project-context builder used by the terminal, headless runner and ACP.

## Trust and directory scope

Calliope discovers the nearest enclosing `.git` directory or worktree marker,
then considers `AGENTS.md` from that checkout root down to the working directory.
An independent nested checkout starts a new boundary. Outside a Git checkout,
only the selected directory is considered.

Use `/trust add` in a repository you trust. Trusting a parent within the same
checkout permits its instructions and those in descendant directories. Trusting
only a child does not permit loading its parents' instructions. Explicitly
untrusting a directory on the applicable chain blocks the entire chain for that
working directory. Unknown checkouts do not load instructions. Trust is a
persistent directory decision, not approval of each file revision.

Files load in root-to-child order. More specific instructions apply to their own
subtree and override conflicting ancestor instructions there. `AGENTS.md` takes
precedence over conflicting project reference context; user instructions and
runtime policy retain priority. The prompt includes every source path and scope.

Only the chain to the working directory loads automatically. The prompt directs
the agent to read additional `AGENTS.md` files before working in deeper
directories. Sibling instructions do not apply. Dynamic per-file enforcement is
not yet implemented.

## Inspect and refresh

```
/trust status
/trust add
/memory sources
/memory reload
```

`/memory sources` lists applicable files currently on disk, their scope and byte
size. It does not claim to show a snapshot of an earlier request. `/memory reload`
rebuilds project context for subsequent turns, retaining the conversation.
Trust changes also refresh context. These commands use the active session's
project directory, including after resuming a different project.

Headless and ACP build instructions when creating a session; start a new session
to pick up changes. Reload cannot retract context already sent to a provider or
remove its influence from earlier conversation messages.

## Limits and failures

The full applicable instruction chain may contain up to 64 KiB of UTF-8 content.
Calliope reports an explicit error if it exceeds that bound; it does not silently
truncate controlling rules. Shorten the files and reload. Files must be regular
files; symlinks must resolve within the trusted directory boundary. Unreadable
files and invalid targets produce errors rather than partial instruction sets.

If an interactive reload fails, stale project context is removed from the system
prompt and the error is displayed. Fix the file and reload before continuing.
`CALLIOPE.md` and legacy reference files retain their existing loading behavior.

The remaining instruction and session work is tracked in the
[next-version roadmap](https://github.com/calliopeai/calliope-cli/issues/254).
