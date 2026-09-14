# Explicit supervision reviewer verdicts

A reviewer can approve the current controller draft without reproducing its
child contracts or confusing approval with `continue`. The review context carries
the draft and `draftHash`, the SHA-256 of its canonical JSON. Reply with:

```json
{"version":1,"verdict":"approve","draftHash":"<exact input hash>","reason":"The recorded evidence supports this bounded draft."}
```

`reject` uses the same fields and stops execution. To propose a different
decision, return `version`, `verdict: "revise"`, `draftHash` and `decision`, where
`decision` is a complete existing supervision decision. Unknown fields, versions,
missing drafts and stale hashes are rejected. Controllers cannot issue verdicts.

Approval copies the current draft's action, parameters, hypothesis and evidence,
and records the reviewer's reason. Rejection retains the draft's evidence IDs in
a stop decision. Every normalized decision passes the existing schema, evidence
and policy validation; application still checks current artifacts, permissions,
budgets, child limits and deadlines. Approval cannot establish a test pass or
grant additional authority.

Legacy complete decision objects remain supported. Their meaning is unchanged:
`continue` asks the executor to check acceptance and advance; it never approves
a different draft. Prose saying “approved” has no effect on that decision.

Controller and reviewer replies may be plain JSON or contain one explicitly
tagged `json` code block. Surrounding commentary is untrusted prose. Multiple or
ambiguous blocks, malformed JSON and replies exceeding 64 KiB of UTF-8 are
rejected. The role is named in malformed or interrupted-response diagnostics.
New prompts request only the compact JSON object.

The exact model reply remains in its private session. Existing execution events
store the validated normalized decision and its reviewer/session identity;
journal schemas, replay and historical records remain unchanged. Smart routing
remains opt-in, and explicit provider/model choices keep their existing meaning.

Native testing exposed these distinctions: a reviewer returned a fenced
`continue` with prose endorsing a decomposition. That failed run is retained;
the prose is never retroactively treated as approval. The [native study ledger](reports/native-supervision-2026-09-14.json) records
fresh exact-hash approvals for both continue and decomposition drafts. The latter
was still refused by executor policy after its parent escalated. No native child
admission or nested recovery succeeded in this study; those remain open.

Source and clean-package SDK tests exercised failed verification, approved replan,
retry, actual Docker checks and offline replay. Those local responses are manufactured
and are separate from the native evidence. General task success rates and full
provider publication readiness are not established by these checks.
