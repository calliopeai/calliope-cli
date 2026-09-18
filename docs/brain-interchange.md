# Brain interchange

Calliope keeps its append-only local Brain journal as the audit and rollback
source. Portable graph exchange uses the `calliope-kg/v1` envelope, which has the
same shape and semantics as Project Brain's `conflict-kg/v1` contract.

```json
{
  "format": "calliope-kg/v1",
  "nodes": [{"id": "stable-id", "name": "Display name", "type": "concept", "props": {}}],
  "edges": [{"source": "node-id", "target": "node-id", "type": "depends-on", "props": {}}]
}
```

Readers and importers must accept both format names. Node IDs are stable within a
graph; node metadata belongs under `props`; and edge endpoints always reference
node IDs. Calliope maps its entity `kind` to `type`, `name` to `name`, and retains
state, confidence, provenance, timestamps, and source locators in `props`. Its
edge `from`/`to` fields map to `source`/`target`.

Project Brain remains the canonical source for scope and engine metadata through
`app/brain-manifest.json`; source documents and generated artifacts are never
overwritten by import. The compatibility proposal is tracked in
[Project Brain issue #82](https://github.com/ConflictHQ/project-brain/issues/82).
