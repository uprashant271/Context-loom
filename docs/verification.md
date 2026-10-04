# Verification record

- Core/provider preservation and strict schema tests pass.
- Loopback HTTPS tests verify certificate trust, encrypted key files, bearer auth, browser cookies/Origin, Host rejection, size limits, snapshots, atomic request limiting and launcher cleanup. All inputs are synthetic.
- Node mod tests cover original handles, grouped tools, pins, version gates, fallback, threshold scheduling and deferred manual requests.
- The real isolated Claude Code2.1.288 strict validator accepts the module. The host loads its commands and retrieves source snapshots through verified TLS.
- Local Qwen3-Reranker + separate Qwen3-0.6B generation successfully compacted a two-message synthetic invoice session through the real HTTPS playground, preserving both originals. This tiny smoke verifies the pipeline, not compression savings.
- The Claude Haiku4.5 development comparison completed30 reader trials under the fixed512-unit memory budget. Raw initial-local and hosted artifacts are retained.
- Headless Chrome verified desktop/mobile recorded traces, evaluation-run switching, threshold interaction, absence of page errors and horizontal overflow.
- Native browser WebMCP is unavailable in the local Chrome context. Its replay action was tested with a mock registry for valid/invalid input and visible state updates; this does not establish native-browser support.
- Real built-in /compact on isolated2.1.288 with Qwen TLSworker and Claude Haiku4.5 succeeded in a controlled synthetic system-prompt session: selected10/10 messages, retained6 originals, recalled originalsource and preserved fixtureconstraint/issueID. Its940 native inputtokens became1423; the tiny smoke does not prove savings.
- Native automatic-threshold/queued idle-session behavior remains subject to live terminal verification. SDK streaming can keep a turn active while awaiting input; queued API compaction then refuses the busy boundary. No success is claimed from those failed attempts.
