# Security: skill & plugin trust (TOFU)

Skills and plugins are code and instructions that Calliope runs **in-process**:

- a **plugin**'s `index.js` is `import()`-ed, so its code executes with the full
  privileges of the CLI;
- a **skill**'s `SKILL.md` is fed into the model's system prompt, so its text can
  steer the agent (prompt injection).

Both can be fetched from the network (the agentskills.io registry, a GitHub URL)
or dropped into `~/.calliope-cli/`. To stop *silent* tampering after you have
accepted an artifact, Calliope pins a content hash at install time and
re-verifies it on every load. This is a **trust-on-first-use (TOFU)** model — the
same shape as SSH host keys.

## What is pinned, and where

| Artifact | Hashed content | Pin store |
|----------|----------------|-----------|
| Skill    | `SKILL.md` (sha256) | `~/.calliope-cli/skills/index.json` → entry `hash` |
| Plugin   | `index.js` (sha256) | `~/.calliope-cli/plugins/trust.json` → entry `hash` |

A short **fingerprint** — `sha256:` plus the first 12 hex characters of the
digest — is shown wherever trust is surfaced, so you can eyeball it.

## The lifecycle

1. **First install / first load (trust-on-first-use).** The artifact is fetched,
   its hash recorded, and the fingerprint printed:

   ```
   ✓ Installed git-workflow — pinned sha256:1a2b3c4d5e6f (trust-on-first-use)
   Plugin toolbox: trusted on first use — entry-file fingerprint sha256:9f8e7d6c5b4a
   ```

   Network installs also pass through a confirmation gate before anything is
   written to disk.

2. **Every subsequent load — verify.** Before a skill enters the prompt or a
   plugin's code is imported, its on-disk content is re-hashed and compared to
   the pin. **Match → load. Mismatch → refuse**, with a clear message telling you
   to reinstall to re-trust. A tampered skill is withheld from the model; a
   changed plugin is never imported.

3. **Audit.** When audit run logs are on (the default — see
   [governance](./governance.md)), a refused load is recorded as a `policy_event`
   with `source: "integrity"` in a dedicated `security` trace, so the tamper is
   not lost to a console warning that scrolls away.

4. **Update — explicit re-pin, never silent.** Reinstalling an artifact whose
   content changed is treated as an update: the confirmation shows the
   `content-changed` reason, and the surface prints the fingerprint diff:

   ```
   ✓ Re-pinned git-workflow: sha256:1a2b3c4d5e6f → sha256:0099aabbccdd (content updated)
   ```

   The pin is only replaced through this visible path.

## Trust state in listings

`/skills` and the plugin list annotate every entry with its trust state:

- the pinned **fingerprint** (`sha256:…`) when the content still matches;
- **`CHANGED`** when the content drifted from its pin (withheld / refused);
- **`UNVERIFIED`** when no hash was recorded (a legacy entry installed before
  pinning);
- **`dev, unverified`** for an exempted local dev plugin (below).

A `CHANGED` plugin refuses to load, so it would otherwise vanish from the list;
it is listed explicitly so the state is never silently hidden.

## Local dev plugins (exemption)

A plugin you are actively editing would re-prompt on every save. You can exempt
it from pinning — but **only as a user-side decision**; a plugin can never mark
itself exempt through its own manifest. Two levers:

- **Env flag** — `CALLIOPE_PLUGIN_DEV=1` exempts *all* plugins for that process
  (blanket dev mode);
- **Config allowlist** — name specific plugins in `plugins.devTrustLocal`:

  ```jsonc
  // ~/.calliope config
  { "plugins": { "devTrustLocal": ["my-wip-plugin"] } }
  ```

Exempted plugins load without pinning and are shown as `dev, unverified`. Skills
installed from a local path are **copied** into the store and pinned like any
other — the exemption is a plugin-only concern, for live-edited code.

## What TOFU does and does not defend

TOFU defends the window **after** you accept an artifact: it catches later
tampering (a compromised update, a local edit, accidental drift) and refuses to
run it.

It explicitly does **not** defend the **first** install. If the registry or the
GitHub source is already compromised the very first time you fetch, TOFU will
faithfully pin and trust the malicious content — there is no prior good hash to
compare against. Closing that gap requires **artifact signing** (verifying a
publisher signature against a trusted key), tracked in
[issue #223](https://github.com/calliopeai/calliope-cli/issues/223).

Other limits worth stating plainly:

- **Scope of the hash.** Only `SKILL.md` (skills) and `index.js` (plugins) are
  hashed. A plugin that `require()`s sibling files, or a skill's `scripts/` and
  `assets/`, are not covered by the pin. Prefer single-file plugins; treat a
  skill's scripts as you would any downloaded script.
- **Transport.** Fetches are plain HTTPS; you are trusting TLS and the registry,
  not a signature.
- **Local attacker.** The pin store lives in the same `~/.calliope-cli/` tree it
  protects. An attacker who already has write access to your home directory can
  rewrite both the artifact and its pin. TOFU raises the bar against remote and
  accidental tampering, not against an adversary who already owns your account.

See also: [governance](./governance.md) for the audit run-log format and
`calliope replay`, and the root [`SECURITY.md`](../SECURITY.md) for reporting.
