# Captured provider responses

This directory contains 36 real captures from nine adapter paths, collected on
September 11, 2026 UTC. See [the live test report](../../../docs/provider-live-testing.md)
for models, gateway routes, server versions, spend and the 28 missing combinations.
Synthetic contracts in `tests/helpers/provider-wire.ts` do not satisfy this gate.

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
