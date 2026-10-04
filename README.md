# Context Loom

An open source context-compaction prototype for terminal coding agents. It selects task-relevant evidence with **Qwen3-Reranker-0.6B**, preserves declared state in code, and asks a separate LLM to summarize. The first adapter uses **Claude Code mods**. The standalone local playground uses **Qwen3-0.6B** for generation.

This is an experimental v0.1, with inspectable measured artifacts rather than a claim of production compatibility or a proven coding-task advantage.

## Try it

Extract the source ZIP and enter its `context-loom` folder. Use Python 3.11 or newer (3.12 was used for the measured run).

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[models]'
loom playground
```

The command downloads the public model checkpoints on first use and starts a TLS worker on `https://localhost:8787`. Models run locally; no API credential is needed. Trust the generated localhost CA in a dedicated browser profile to open its playground. The printed CA path belongs to that process; no system trust settings are changed automatically. Private key files are encrypted with a process-only password and removed on normal launcher exit. Stop with Ctrl-C. On a machine without a compatible GPU the engine uses CPU, which can be slower.

For the easiest first try, open the portfolio website's recorded session explorer. Its traces are real saved model outputs; choosing a method does not run new inference on the hosted site.

### Attach to Claude Code

After installation, this is the single attachment command:

```sh
loom attach
```

Requires **Claude Code 2.1.287+** and valid Claude authentication for its native LLM summary. Older hosts cannot load the mod; 2.1.288 is the tested build. The launcher accepts `--claude /path/to/compatible/claude` for an isolated install and passes your remaining Claude arguments after `--`. It does not update your global CLI, edit global hooks, or alter your settings. An isolated 2.1.288 was used to verify mod loading, static API validation and verified TLS retrieval. A real synthetic session on 2.1.288 verified Qwen selection, native Claude Haiku 4.5 summarization, pinned retention, source recall and a follow-up constraint answer through the built-in `/compact` command. Its tiny context grew from 940 to 1,423 native tokens, so it is integration proof, not evidence of savings. SDK streaming keeps the session active between inputs, so queued `/loom-compact` and automatic idle scheduling remain experimental and unverified in that mode.

```sh
CONTEXT_LOOM_THRESHOLD=0.70 CONTEXT_LOOM_TARGET_RATIO=0.40 loom attach
# In the session:
/loom-status
/loom-pin latest
/compact                 # Verified native path intercepted by the mod
/loom-compact            # Experimental queued idle request
/loom-recall SNAPSHOT_ID
/loom-recall SNAPSHOT_ID m0 m1
```

The 70% trigger schedules at a safe turn boundary. Unknown usage does not trigger. A one-minute cooldown and ten percentage-point hysteresis prevent repeated attempts. The conversation target is 40% of the reported context window, capped at 200,000 budget units. It is an aim, not a guarantee. Claude's fixed system/tool overhead is outside this conversation budget.

### Standalone JSON API

Input contains `messages`, `task`, optional message-ID `pins`, and optional `config`. A message has a unique `id`, `role`, and string `content`; assistant `tool_calls` and result `tool_call_id` identities connect complete tool groups.

```json
{"task":"Fix invoice parsing", "messages":[
  {"id":"u1","role":"user","content":"Preserve invoice INV-0042 exactly."},
  {"id":"a1","role":"assistant","content":"Pending: add a parser regression case."}
], "pins":["u1"], "config":{"target_tokens":1024}}
```

```sh
loom plan session.json
loom compact session.json                  # Local generative Qwen
loom compact session.json --summary-provider claude --model haiku
loom plan session.json --ranker lexical    # Explicit deterministic baseline
```

`--ranker lexical` is a labeled development baseline, never a silent fallback from Qwen. A failed or invalid summary returns `blocked` without replacement messages. No model output is silently truncated to force it into a budget.

## How it works

1. Normalize complete message/tool groups and identify protected state.
2. Retain system/developer instructions, ordinary user messages, declared pins and recent groups verbatim. Result-only user rows from Claude remain tool evidence. Pin unresolved tasks explicitly; this version does not guarantee semantic detection of every implicit decision or task.
3. Score groups against the current task with Qwen's final yes/no logits. This is a relevance score, not a calibrated probability of safe retention.
4. Fill the summarizer's source budget in rank order, preserving original chronology. Source and final memory budgets are separate.
5. Generate a factual summary with a separate LLM. Validate source-ID attribution, structure, hidden controls and final budget, then combine it with retained originals.
6. Keep originals accessible through authenticated, expiring worker snapshots. Summary attribution is a source map, not semantic proof of faithfulness.

The standalone engine refuses replacement on failure. The Claude adapter delegates native fallback when its custom selection cannot be applied; if custom retention validation fails after the native model has produced a result, it uses that native result. A native summary error skips compaction and retains the original context.

## Evaluation

The Claude Haiku 4.5 development comparison completed: hybrid, full-history LLM summaries and recency each passed 6/6 automated checks; protected recency passed 5/6 and LLMLingua-2 passed 4/6. The hybrid averaged 8.87s versus 7.40s for full-history summarization. These six previously inspected synthetic cases do not establish superiority. One LLMLingua failure is a known false positive from the crude forbidden-string rubric. The initial tiny-local-reader run scored 0/6 for all methods and remains available.

See `evaluation/README.md`, the saved `evaluation/runs/` artifacts and the website. Six authored synthetic coding histories compare recency, protected recency, full-history LLM summarization, Context Loom hybrid and LLMLingua-2 under a fixed final budget. Future questions are withheld from the compactor and used only by the reader. Exact string checks measure QA field retention and abstention; this is **not a coding-task completion benchmark**.

The controlled benchmark uses explicit fixture pins and disables all-user protection. The default plugin policy remains more conservative. Report these separately. Every model error, invalid output and blocked replacement stays visible in the results. The Qwen tokenizer plus framing is a declared budget convention, not authoritative Claude context occupancy.

```sh
pip install -e '.[evaluation]'
python evaluation/run.py --check-fixtures
python evaluation/run.py --run --provider local --methods recency protected_recency full_llm_summary hybrid llmlingua2 --output evaluation/runs/my-run
python -m pytest tests evaluation/test_fixtures.py
node --test tests/test_plugin.mjs tests/test_site.mjs
```

See the runner's `--help` for fixed budgets and hardware options. Model downloads and first-load time can dominate a cold run. Generated content is stochastic across implementations or hardware even with greedy decoding; inspect raw responses, not only aggregate scores.

## Privacy and retrieval

The worker binds to loopback with verified TLS, validates Host and browser Origin, uses an ephemeral bearer for the plugin and HttpOnly/Secure/SameSite cookies for the local browser, limits input size and requests, and serializes inference. It never logs transcript bodies or writes a transcript cache to disk. Up to 16 original snapshots are retained in RAM for 60 minutes; they are unavailable after expiry, eviction or restart. This is not a durable archive. Browser content stays in memory and is not saved to localStorage or sessionStorage.

Local Qwen generation sends no transcript to the portfolio site. Choosing Claude summary uses your existing provider and normal provider usage. The benchmark artifacts contain only synthetic data. A durable encrypted archive and cross-session recovery are future work.

## Current boundaries

- Claude mod APIs are early access. New host versions require validating their generated declarations and a real supported-session test.
- Codex and OpenCode need separate adapters; this release does not attach to every terminal agent.
- Large tool results exceeding the Qwen pair limit cause a safe failure. No chunk is secretly truncated.
- Explicit state may fill the target. The engine refuses replacement rather than dropping protected instructions.
- The small local LLM is a reproducible open source baseline. Its performance does not stand in for a stronger hosted model.
- Laya is a separate planned decision-detection experiment; it is not in the runtime pipeline.

MIT covers this project's code. Qwen checkpoint licenses are Apache 2.0. LLMLingua code and model licenses remain with their respective authors; weights are downloaded separately and are not redistributed in this ZIP.
