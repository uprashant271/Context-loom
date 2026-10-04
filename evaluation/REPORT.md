# Evaluation report

The current [hosted development comparison](HOSTED_REPORT.md) used restored Claude authentication and `claude-haiku-4-5` as summarizer and reader on the same six synthetic cases. All 30 reader responses completed. Hybrid, full-transcript LLM summary, and the implemented recency baseline each scored 6/6 automated all-required checks; protected recency scored 5/6 and LLMLingua-2 scored 4/6. One LLMLingua failure is a documented forbidden-substring rubric false positive in an otherwise correct answer. No superiority is established, and the previously inspected fixtures are not held-out or independent confirmation. Current machine-readable results are in [summary.json](summary.json).

## Archived first local experiment

Six authored synthetic coding histories were evaluated under a fixed 512-unit memory budget, using Qwen tokenization plus explicit message framing allowances. The hybrid used a 768-unit source-selection cap and a 192-token generation allowance. Future evaluation questions and expected answers were withheld from compaction.

The generative summarizer and reader were the same local **Qwen3-0.6B**, non-thinking, greedy configuration. This is a small local baseline, not a comparison against a stronger hosted LLM. Actual Qwen3-Reranker-0.6B inference and actual LLMLingua-2-small compression were used. Raw model outputs, failures, dependency versions, revision metadata and native generation token counts are preserved in [the run artifact](runs/local-512-final/results.json).

| Method | Complete reader answers | All-required QA passes | Failed or blocked trials |
|---|---:|---:|---:|
| Recency | 3/6 | 0/6 | 3/6 |
| Protected recency | 3/6 | 0/6 | 3/6 |
| Full-transcript LLM summary | 2/6 | 0/6 | 4/6 |
| Hybrid | 3/6 | 0/6 | 3/6 |
| LLMLingua-2 | 3/6 | 0/6 | 3/6 |

No improvement is established by this run. The reader often answered only part of a multipart question even when the evidence remained in memory: for example, it returned the approved SQLite engine and 45-minute expiry but omitted the required public method name. The JSON/schema/output limits also produced failures. Failures were preserved without retry, repair, or budget tuning. Completed-only field-recall figures have different denominators and should not be presented as a fair ranking of the compaction methods.

First-run structural caveat: the reader grader checked required `answer`/`abstain` types, but did not enforce `additionalProperties: false`; several observed answers included an extra `type` property. Strict schema conformance was therefore not established. The raw results and scores remain unchanged while the provider guard is hardened afterward.

A separate [selection/compression run](runs/selection-512/results.json) completed all six Qwen plans and all six LLMLingua outputs. In the long-noise case, the 4,557-unit source became a 746-unit hybrid selection plan with 105 units retained verbatim; no summary was generated in that run. LLMLingua produced 470 units of final memory. These observations verify execution and budget behavior, not answer quality.

The initial attempted Claude comparison was blocked by an expired OAuth session that could not be refreshed. Authentication was subsequently restored, and a separate [hosted development comparison](HOSTED_REPORT.md) measured the same fixtures with a capable fixed reader. The initial local results above remain unchanged. A held-out continuation suite is still needed; coding task completion and live terminal-agent compaction remain unmeasured.
