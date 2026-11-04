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
Logout, quota errors and refresh failures never switch billing methods automatically.

Models come from the active account's live catalog. The adapter sends the complete
history with `store: false`, streams through `response.completed`, and returns tool
calls to Calliope's existing permission and execution loop. Private reasoning state
is saved with conversation history and bound to the account and model. Start a new
session to change either or to switch that history back to API-key access.

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
