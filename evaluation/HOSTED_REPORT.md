# Hosted development comparison

After Claude authentication was restored, the same six authored histories were evaluated with **claude-haiku-4-5** as the fixed summarizer and reader. Qwen3-Reranker-0.6B and LLMLingua-2-small remained the actual local selection/compression models. The final memory cap was 512 Qwen-tokenization/framing units; hybrid source selection was capped at 768 and summary generation at 192. Future questions and gold values stayed outside compaction.

This is a **development comparison on previously inspected fixtures**, after generic protocol/schema hardening and a change from the tiny local reader to the hosted reader. It is not held-out evaluation or independent confirmation. No fixture-specific answers, question knowledge, budget tuning, repairs, or retries were introduced. The [first local run](REPORT.md) remains archived with every method at 0/6 complete QA passes and its original schema-validation caveat.

| Method | Completed reader responses | Automated all-required passes | Pipeline errors/blocked |
|---|---:|---:|---:|
| Recency | 6/6 | 6/6 | 0 |
| Protected recency | 6/6 | 5/6 | 0 |
| Full-transcript LLM summary | 6/6 | 6/6 | 0 |
| Hybrid | 6/6 | 6/6 | 0 |
| LLMLingua-2 | 6/6 | 4/6 | 0 |

**Hybrid ties the full-transcript LLM baseline and the implemented recency baseline. No superiority is established.** All 30 reader responses completed. The 42 observed provider invocations cost $0.493398 in this run; this is recorded spending, not a general pricing or savings claim. Raw responses, usage envelopes, model IDs, runtime hashes, revisions and timings are available in [the run artifact](runs/claude-512-final/results.json).

The long-noise history used 4,557 units. The hybrid selected 746 source units for summarization and produced 268 final memory units. The full-transcript LLM summary produced 79 final memory units and passed the same question. The methods obeyed the same upper cap; their actual final memory sizes differ. Source-selection reduction is not equivalent to total cost, latency, or final-memory improvement.

Recency selects complete groups in reverse chronological order, skips oversized groups that cannot fit, then restores source order. In the noise case this implementation happened to fit the older `noise-2` message containing the regression test. Protected recency spent that space on the declared `noise-1` pin and missed the test/path; it correctly abstained. This is a property of the implemented allocator on this case, not a general finding that protection hurts memory.

LLMLingua missed the noise-case test/path. Its other automated failure is a **rubric false positive**: the identifier answer gives all four exact correct values, then correctly notes that another request ID belongs to an unrelated case. Mentioning that unrelated ID triggers the forbidden-substring check. The automated 4/6 score is preserved, and this observation is recorded separately; no rubric or scores were changed after seeing the answer.

These small, synthetic results do not establish coding task completion, native-agent compaction quality, held-out generalization, real-history performance, or causal cost/latency improvement. A larger frozen continuation suite and multiple trials should precede such claims.
