# Reviewed semantic wire captures

Only real provider responses produced by `scripts/conformance/capture-semantic.mjs`
and reviewed for secrets/content belong here. Manufactured test traffic stays in
memory in the harness tests. Each capture includes fixed public toy request bytes,
response bytes, checksums, SDK versions, origin, per-turn budget reservation IDs
and the observed outcome. Cancellation retains a partial response and proves client
abort after bytes arrived; it does not prove when remote computation or billing stopped.

The replay suite verifies the requests and expected behavior through actual SDKs.
See `docs/provider-conformance.md` for bounds and release requirements.
