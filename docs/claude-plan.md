# Local Claude plan delegation

Use your existing local Claude agent from Calliope AI CLI:

```sh
claude auth login
calliope claude status
calliope claude -- Review this project
calliope claude --print -- Summarize the README
calliope claude --model <model-from-Claude> --permission-mode plan -- Plan the change
```

Install the official Claude Code CLI first. Authentication remains in that tool;
Calliope does not extract its tokens, offer its own Claude login, or send those
credentials to the Anthropic Messages API. Use a recent version supporting
`auth status` and `--permission-prompts` (2.1.259 or later).

This command delegates the whole agent session. Claude owns tools, permissions,
conversation state and plan usage. Calliope's native sandbox, reviewed-run ledger,
token/output bounds and dollar budgets do not apply. Native `--provider anthropic`
continues to use its existing API-key adapter.

Interactive delegation starts with default permissions unless `plan` is chosen.
Print mode denies unanswered permission prompts. Only the documented wrapper
options are accepted; use `--` before a prompt. No permission-bypass flag is added.
Model names are forwarded explicitly or left to Claude's own selection.

Calliope checks `claude auth status` for a saved `claude.ai` login before starting.
It removes inherited Anthropic credentials/provider selectors and disables
user/project settings sources for both the check and the delegated run. Managed
Claude policy still applies and can prevent launch. These settings mean personal
Claude configuration may differ from a normal direct launch. Claude's own plan and
extra-usage settings determine consumption; this is not a promise of unlimited or
zero-cost requests. Calliope does not silently switch to an API key.

Cancellation is forwarded to the child process; a child that does not terminate
receives SIGKILL after two seconds. The command returns Claude's exit status.

## Support guidance discrepancy

As checked on 2026-11-04, the support article says signed-in Agent SDK and `claude -p`
usage continues to draw from subscription limits. The SDK overview separately says
third-party products need prior approval to offer claude.ai login/rate limits.
This implementation is an explicit launcher of the user's installed local CLI,
not an embedded SDK provider or a new login offering. Broader embedded SDK
subscription support remains subject to clarification of that published guidance.

- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/authentication

Automated tests cover argument/environment isolation, auth preflight, cancellation,
status-output limits and exit propagation. Subscription inference requires an
eligible user's existing Claude login; tests do not consume a real plan.
