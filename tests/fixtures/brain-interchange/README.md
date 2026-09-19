# Shared core exchange fixtures

Source: ConflictHQ/project-brain PR #107, commit
`e59f77992a63f17032b7258b6f5e00947435bed3`. These synthetic fixtures match
`template/tests/fixtures/interchange/` at that commit.

The archive uses explicit brain-exchange/v2 and RFC 8785 digests; v1 archives
must be validated/unpacked by the core before explicit v2 repacking. Neither
an archive digest nor imported scope/capability metadata grants destination
authority. The native journal schema and checksum remain unchanged.

| Fixture | SHA-256 file bytes |
|---|---|
| exchange-v2.json | `a52548166a52f3a8d69a765547c037d0f1e95c9a164f7382294ae77dee8dfce1` |
| jcs-cases.json | `72ca46a8df5d70a20bc8d992cf9afaaf597bb19e0ebd7a8da60faa7894971e32` |
| cli-bundle.json | `8fc8de634ae2adf1aba51d41bbb74474efb5c89dcb053d12712f687c980ba262` |

## Studio producer fixtures

`studio-native.json` and `studio-graph.json` were emitted by the real
`to_cli_bundle` and `export_graph` adapters at Studio release commit `4ffcd9e`
(PR #420), using `test_brain_interop.authored_brain` in isolated temporary
workspace/data directories, with extraction and the legacy mirror disabled.
They contain synthetic pipeline notes and a two-node manual graph. The CLI
imports these without a shared writer; both graph aliases share one origin.
Studio's original projection loss report applies to its synthesized native
bundle (it is not Studio's complete Git history).

The same Studio adapter imported the CLI's core-fixture exports for both KG
names and native journal JSON in isolated destinations and retained repeat
receipts. Its v2 envelope reader and stronger reconciliation are tracked in
[Studio #421](https://github.com/calliopeai/calliope-chat-studio/issues/421).

| Studio fixture | SHA-256 file bytes |
|---|---|
| studio-native.json | `34221c3fd4ceb780be958119c6e366912c322c8e076aa7957078ccbcbe85c5dd` |
| studio-graph.json | `847007bf79bcaa0a80d112909b07768d05e2f159c3ce745bbc0c822e8ad82823` |
