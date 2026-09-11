# Captured provider responses

No real provider responses have been supplied or captured for this release yet.
Synthetic wire contracts live in `tests/helpers/provider-wire.ts` and do not
satisfy the real-capture release gate.

Run `npm run capture:provider -- --help` for the opt-in toy probe recorder. Live
API calls require authorization for the specific provider/model and spend.
The recorder accepts only a fixed text/tool prompt, never executes returned
tools, caps output, allows one HTTP request, and stores response bytes with
SHA-256, timestamp, model, SDK versions and content type. Request credentials,
headers, arbitrary prompts and project files are never recorded. Review decoded
bytes and the normalized expected result before committing a capture.

A capture's provenance declaration cannot cryptographically prove that it came
from a provider. Human review must verify its origin and expected semantics;
checksums detect later corruption only. Replay uses the actual SDK with all
networking intercepted. The release gate requires text and tool captures in JSON
and streaming mode for each adapter path listed in the conformance matrix.
