# Evaluation

This suite measures **synthetic coding-session QA retention**, not coding task completion. Six authored histories exercise corrections, exact identifiers, pending work, tool evidence, unrelated history, and abstention. They contain no personal transcripts or production observations.

`fixtures.json` is generated deterministically by `build_fixtures.py`. Its `evaluation` fields contain future questions, expected alternatives, and evidence labels. Only `messages`, the **current** `task`, and declared `pins` enter compaction. Future questions and expected answers are withheld until the reader phase.

## Validation without models

```sh
python evaluation/run.py --check-fixtures
```

The 12 stdlib tests check schema/reference integrity, withholding evaluation data, tool grouping, pinned-budget refusal, and transparent grading. Passing these checks does not establish Qwen relevance, LLM summary quality, or plugin behavior.

## Measured runs

```sh
python evaluation/run.py --run --provider local \
  --model Qwen/Qwen3-0.6B --ranker qwen --device cpu --llm-device auto \
  --memory-budget 512 --summary-budget 192 --source-budget 768 \
  --methods recency protected_recency full_llm_summary hybrid llmlingua2 \
  --output evaluation/runs/local-512
```

This explicitly enables public model downloads/inference. The local summarizer and reader are the same fixed generative checkpoint. It is a tiny local LLM baseline, not a substitute for a measured comparison against a stronger hosted model or an agent's native compactor. `--provider claude` uses the installed no-tools Claude provider and requires valid local authentication; `--max-budget-usd` is a **per invocation**, not total-run, limit.

`--selection-only` runs real relevance/selection and optional extractive compression without an LLM summarizer or reader. Its QA metrics remain null. LLMLingua-2 is optional and is marked skipped if its package is absent. In a measured run it loads the official BERT-small multilingual MeetingBank checkpoint.

## Fairness and interpretation

All methods receive the same history and current task. Every completed reader receives memory within the same final memory budget. The full-LLM baseline uses the same summarizer as the hybrid and sees the entire source transcript. Recency keeps complete tool cycles, and protected recency additionally retains the declared pin groups. The hybrid adds relevance selection before summarization. The LLMLingua branch is extractive.

The budget counter is disclosed in every artifact. Qwen tokenization is exact for its text encoding; message serialization and an explicit framing allowance are benchmark conventions. They are **not** exact native coding-agent occupancy or Claude token counts. The future reader question and common instructions are additional input; their counts are reported separately. No future-question knowledge guides ranking.

The controlled experiment disables “preserve all user messages” and uses the fixture's declared pins. This isolates ranking; it differs from the conservative engine default. A missing pin, unsupported semantic relationship, or summary hallucination can still lose information. Pinning itself does not automatically discover every natural-language constraint.

Scoring uses explicit required substring alternatives, forbidden phrases, and the reader's abstention flag. It is transparent but imperfect; inspect raw answers for semantic false positives or false negatives. Six authored cases are small and non-independent, and do not establish general performance, calibrated confidence, or improvement on real coding tasks. These cases should be kept separate from a future held-out test set after tuning.

Each run preserves a manifest, per-case artifacts, JSONL records, raw provider traces, counter kind, model identifiers/revisions where available, prompt version, source-selection/final budgets, dependency versions, and measured durations. Cold downloads/loading may affect the first case; latency aggregates are descriptive, not a controlled warm-runtime speed comparison.

## Hosted development comparison

Claude authentication was restored for a subsequent fixed comparison using `claude-haiku-4-5` as summarizer and reader. All 30 reader trials completed: recency 6/6, protected recency 5/6, full-transcript LLM summary 6/6, hybrid 6/6, and LLMLingua-2 4/6 automated all-required checks. Hybrid ties the full-LLM and implemented recency baselines; no superiority is established. One LLMLingua failure is a forbidden-substring rubric false positive in an otherwise correct answer, preserved and explained separately.

This uses the same previously inspected six fixtures after generic protocol/schema hardening, so it is a development comparison, not held-out or independent confirmation. See [HOSTED_REPORT.md](HOSTED_REPORT.md), current [summary.json](summary.json), and [hosted raw results](runs/claude-512-final/results.json). The first local run remains available in [initial_local_summary.json](initial_local_summary.json).

## First-run outcome

The fixed local run completed 30 planned trials across six cases and five methods. Fourteen reader responses completed; fifteen trials errored and one hybrid trial was blocked. Every method scored **0/6 all-required QA passes**. The tiny reader frequently omitted requested fields even when original memory retained them. JSON/schema/output failures are distinct from factual recall; completed-only field-recall denominators differ between methods and cannot fairly rank them. No improvement is established. See [REPORT.md](REPORT.md), [initial_local_summary.json](initial_local_summary.json), and the preserved [raw results](runs/local-512-final/results.json).

This first run checked the reader's required string/boolean fields, but did not reject extra JSON properties. Several raw answers included an extra `type` property contrary to the requested schema. These outputs remain in the artifacts as observed; the first run does not prove strict schema conformance. The provider is subsequently being hardened to reject additional properties. No first-run answers or scores have been rewritten to suggest that later guard ran earlier.

## Upstream references

- [Qwen3-Reranker-0.6B model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B): relevance ranking checkpoint, Apache-2.0.
- [LLMLingua repository](https://github.com/microsoft/LLMLingua) and [BERT-small weights](https://huggingface.co/microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank): token classification compression comparison.
- [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LoCoMo](https://github.com/snap-research/locomo), and [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2): useful future memory evaluations. They are different tasks from coding-agent continuation; no results from them are claimed here.
