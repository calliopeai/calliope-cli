# Permission decisions

Terminal, headless and ACP execution use `resolvePermission` from `src/runtime`.
Every result is `allow`, `deny`, `confirm` or `cancelled`, with a deciding layer,
a one-line reason and elapsed time. The same reason is shown to the client,
returned to the model and recorded in a `policy_event`. Events include the tool
call ID so multiple calls of the same tool can be distinguished.

Checks run in this order:

1. Plan mode permits `think`, `ask_question`, `create_plan`, `read_file` and
   `list_files`, preserving the existing read-only allowlist.
2. The client confirmation policy may request approval. Approval cannot override
   any of the following checks.
3. Scope, the advisory shell blocklist, and explicitly required sandbox backends
   must permit the operation.
4. Pre-tool hooks may veto execution.
5. A configured external policy must allow execution. Gate errors fail closed.

| Client | Confirmation default |
| --- | --- |
| Terminal | Apply risk-based confirmation when its confirmation toggle is enabled |
| Headless | No interactive confirmation; invocation authorizes execution subject to hard gates |
| ACP | Request editor approval for shell, file mutations, git, code, configure, and tools marked as requiring confirmation by the risk model |

For example, a hook denial reads `[hook] Blocked by hook: repository freeze`.
An editor approval followed by a policy refusal still produces a denial. If the
client cannot answer a required approval request, the operation does not run.
Cancellation interrupts a pending permission wait; a late approval cannot start
the cancelled tool.

Headless now honors pre-tool hooks as well as external policy. This corrects its
previous omission. Client confirmation defaults and the plan allowlist remain
unchanged. Hooks themselves may perform effects before cancellation; cancellation
does not undo those effects.

The executor repeats scope and required-sandbox checks immediately before tool
execution, and records a changed boundary as a new denial. Dangling symlinks are
rejected instead of being reconstructed as ordinary new files. Scope checks and
shell blocklists are advisory checks around filesystem/process operations; they
are not substitutes for an OS/container sandbox or protection against every
filesystem race. See [sandbox modes](./features.md#sandboxing).
