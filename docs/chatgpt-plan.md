# ChatGPT plan access

Experimental in 3.8.0: opt-in access with fixture-based implementation tests.
Live subscription prompt/tool qualification remains outstanding.

Calliope AI CLI can explicitly select ChatGPT-plan inference instead of an OpenAI
Platform API key. This uses the open-source Sign in with ChatGPT flow and the public
Responses API. Availability and usage limits depend on the signed-in account.

```sh
calliope auth chatgpt login
calliope auth chatgpt status
calliope --provider openai
```

Login opens the system browser with a temporary IPv4 loopback listener. Complete
consent in that browser. Calliope validates the signed identity before activating
an account. The initial sign-in registers a client; credentials and a stable host
ID are saved privately beside the CLI config, under `chatgpt-auth/`.

`status` lists registrations without credentials. Use `login <client-id>` to
reauthorize a saved registration, `use <client-id>` to select another signed-in
account, and `logout` to revoke the active renewable session and clear local tokens.
Logout retains the client/account mapping and host ID. Run `login` without an ID to
register another account/workspace. Concurrent credential changes fail with a busy
message; after a crash, remove `chatgpt-auth/lock` only when no Calliope process uses it.

`calliope auth chatgpt api-key` explicitly restores normal OpenAI API-key access.
An environment API key or configured proxy never overrides selected ChatGPT access.
Logout and refresh failures never change billing methods automatically. Quota
failures can use the explicitly configured paid fallback described below.

Models come from the active account's live catalog. The adapter sends the complete
history with `store: false`, streams through `response.completed`, and returns tool
calls to Calliope's existing permission and execution loop. Private reasoning state
is saved with conversation history and bound to the account and model. Outside
the configured quota fallback, start a new session to change either or switch
that history back to API-key access.

Subscription requests cannot enforce `max_output_tokens` or API dollar budgets;
Calliope rejects those requests before inference, including reviewed/bounded runs.
Token usage is recorded, but USD totals exclude subscription consumption. This does
not mean the subscription is free or unlimited. Plan limits remain with ChatGPT.
Cancellation and ordinary Calliope tool permissions still apply.

Implementation tests use synthetic OAuth/JWKS and streamed Responses fixtures.
They do not prove account eligibility or real subscription inference. Release
qualification requires a user-operated login, live model discovery and a minimal
prompt/tool round trip on an eligible account; no credentials belong in captures.

References (checked 2026-11-04):
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

## Quota circuit breaking and paid fallback

Quota exhaustion opens an account-specific circuit for one hour; a rate limit
pauses subscription requests for one minute. The private state survives process
restarts. `status` shows the circuit and `reset` allows an explicit early probe.

Fallback is disabled by default. After configuring your OpenAI API key, opt in
with an exact model ID from that key's live model catalog and a shared project
spending ceiling (USD):

```sh
calliope auth chatgpt fallback models
calliope auth chatgpt fallback enable <api-model> <max-project-cost-usd> [max-output-tokens]
calliope auth chatgpt fallback status
calliope auth chatgpt fallback reset
calliope auth chatgpt fallback disable
```

The `models` command lists the API key's live catalog and endpoint target digest
without changing your selected billing method or sending inference. Use that
digest when preparing a reviewed billing profile.

The output cap defaults to 4096 tokens. Existing recorded project spending counts toward
the ceiling; enabling fallback, starting a new process or resetting the quota
circuit does not replenish money. A stricter existing project cap still applies.
Each paid attempt reserves its maximum billable cost before dispatch using the
native project ledger. Concurrent callers share the same allowance. Failed or
cancelled requests retain their reservation; missing prices, capabilities or
limits stop inference. If the provider's model catalog omits these fields,
configure [reviewed billing metadata](reviewed-provider-metadata.md) for the
API-key endpoint before using fallback. Paid usage totals use the conservative
rates from the reservation; the provider's invoice remains authoritative.

On a quota failure before output, the ordinary terminal/headless/ACP turn can
continue through the API key. A visible warning identifies paid billing and its
cap. Public conversation and completed tool results are preserved; encrypted
subscription state is removed. The saved session stays on the paid model even
when the quota cooldown expires. Start a new session to try the plan again.
Changing the fallback model or account requires a new session. Disabling fallback
stops an existing fallback session rather than silently changing its billing.

There is no automatic replay after partial subscription output, cancellation,
refusal or authentication failure. Paid fallback has no transport retries; an API quota or rate-limit failure stops
the turn even if the client normally retries errors. It never switches back to an
exhausted subscription. Native tool permissions remain
in force. Reviewed task/ledger execution and reviewed Smart routing cannot change
billing targets this way; approve an API-key run explicitly for those workloads.

### Organization access denied

If OpenAI shows `3p_delegated_access_policy_denied` with “Your organization hasn’t enabled access for this app,” cancel the waiting CLI login and ask the ChatGPT workspace administrator to enable app access. Preserve the request ID for private OpenAI support if the setting is unavailable. Retry only after the policy changes. This is an authorization failure, not a quota event; it does not activate automatic paid fallback. You can explicitly select API-key access separately.

The 3.8.0 operator check reached the browser consent screen but was denied by this organization policy. Live subscription inference and tool execution remain unqualified.
