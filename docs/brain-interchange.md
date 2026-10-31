# Brain interchange

Calliope keeps its append-only local Brain journal as the audit and rollback
source. Portable graph exchange uses the `mimwell-kg/v1` envelope, the graph
contract of Mimwell (formerly Project Brain). The legacy `calliope-kg/v1` and
`conflict-kg/v1` names carry the same shape and semantics.

```json
{
  "format": "mimwell-kg/v1",
  "nodes": [{"id": "stable-id", "name": "Display name", "type": "concept", "props": {}}],
  "edges": [{"source": "node-id", "target": "node-id", "type": "depends-on", "props": {}}]
}
```

Calliope writes `mimwell-kg/v1` and reads all three names. Node IDs are stable within a
graph; node metadata belongs under `props`; and edge endpoints always reference
node IDs. Calliope maps its entity `kind` to `type`, `name` to `name`, and retains
state, confidence, provenance, timestamps, and source locators in `props`. Its
edge `from`/`to` fields map to `source`/`target`.

Project Brain remains the canonical source for scope and engine metadata through
`app/brain-manifest.json`; source documents and generated artifacts are never
overwritten by import. The compatibility proposal is tracked in
[Project Brain issue #82](https://github.com/ConflictHQ/project-brain/issues/82).
