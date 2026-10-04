"""Author the deterministic synthetic memory-retention fixtures; no model calls."""
import json
from pathlib import Path


def message(identifier, role, content, **extra):
    return {"id": identifier, "role": role, "content": content, **extra}


def case(identifier, difficulty, task, messages, pins, question, required, forbidden, evidence, abstain=False):
    return {
        "id": identifier,
        "source": "synthetic",
        "evaluation_scope": "synthetic_qa_retention",
        "difficulty": difficulty,
        "task": task,
        "messages": messages,
        "pins": pins,
        "evaluation": {
            "question": question,
            "required": required,
            "forbidden": forbidden,
            "evidence_ids": evidence,
            "expected_abstain": abstain,
        },
    }


def fixtures():
    return [
        case(
            "correction", "correction", "Finish the local task-index implementation using the accepted storage decision.",
            [
                message("corr-1", "user", "We need a local task index. Initial thought: use Redis and a 10 minute cache expiry."),
                message("corr-2", "assistant", "Draft plan: add a Redis client and expire entries after 10 minutes. This is a proposal awaiting approval."),
                message("corr-3", "user", "Correction to the draft: use SQLite from the standard library, no Redis dependency. The accepted expiry is 45 minutes. This replaces the earlier 10 minute proposal."),
                message("corr-4", "assistant", "I will implement SQLite storage and leave migration validation as pending work."),
                message("corr-5", "user", "Keep the public method name lookup_task unchanged."),
                message("corr-6", "assistant", "I have inspected lookup_task and located the storage boundary. No implementation or migration validation has run yet."),
            ], ["corr-3", "corr-5"],
            "What storage engine and expiry were finally approved, and what public method name must remain?",
            [["sqlite"], ["45 minutes", "45 minute", "45-minute"], ["lookup_task"]],
            [], ["corr-3", "corr-5"],
        ),
        case(
            "identifiers", "exact_identifiers", "Continue investigating the cache expiry regression in the designated module.",
            [
                message("id-1", "user", "Synthetic issue SYN-184 concerns src/cache/ttl.ts. Trace this exact request identifier: req_7H4c91A2b. Compare against synthetic commit 9c7e2b1."),
                message("id-2", "assistant", "Located src/cache/ttl.ts. The comparison commit is 9c7e2b1; req_7H4c91A2b is the relevant request."),
                message("id-3", "user", "An unrelated discussion used req_7H4c91A2c, but that identifier belongs to a separate case."),
                message("id-4", "assistant", "The expiry guard compares elapsed_ms to ttl_ms. I will inspect the zero-value behavior next."),
                message("id-5", "user", "Continue with the original regression, without changing exported names."),
                message("id-6", "assistant", "The next step is to trace the elapsed-time calculation."),
            ], ["id-1", "id-5"],
            "Which exact issue, module path, request identifier and comparison commit belong to this regression?",
            [["syn-184"], ["src/cache/ttl.ts"], ["req_7h4c91a2b"], ["9c7e2b1"]],
            ["req_7h4c91a2c"], ["id-1"],
        ),
        case(
            "pending", "pending_work", "Resume implementation of shutdown handling while respecting the user's remaining checklist.",
            [
                message("pend-1", "user", "Implement clean shutdown for the worker. Do not commit or push changes."),
                message("pend-2", "assistant", "Completed: locate the cancellation handler. Proposed remaining work: add a SIGTERM cleanup test, exercise cancellation twice, and update docs/shutdown.md."),
                message("pend-3", "user", "Confirmed remaining checklist: SIGTERM cleanup test and docs/shutdown.md update. The double cancellation exercise is removed from scope. Preserve this checklist as pending until each item is actually done."),
                message("pend-4", "assistant", "I changed the handler in the working tree. I have not written the SIGTERM test or updated docs/shutdown.md."),
                message("pend-5", "user", "Also keep the shutdown timeout at exactly 8 seconds."),
                message("pend-6", "assistant", "The handler change is ready for a local review. There is no evidence of a passing test run yet."),
            ], ["pend-1", "pend-3", "pend-5"],
            "What two items remain pending, what exact shutdown timeout is required, and may the agent commit or push?",
            [["sigterm"], ["docs/shutdown.md"], ["8 seconds", "8 second", "8-second"], ["do not commit", "must not commit", "no commit", "not commit", "cannot commit", "may not commit", "not allowed to commit"], ["do not push", "must not push", "no push", "not push", "cannot push", "may not push", "not allowed to push", "commit or push", "commit/push"]],
            [], ["pend-1", "pend-3", "pend-4", "pend-5"],
        ),
        case(
            "tool-evidence", "tool_evidence", "Diagnose the latest worker-queue test failure and report what was actually tested.",
            [
                message("tool-1", "user", "Investigate the worker-queue tests. Earlier success must not be reported as validation of later edits."),
                message("tool-2", "assistant", "Checking the tests before editing.", tool_calls=[{"id": "call-old", "type": "function", "function": {"name": "shell", "arguments": json.dumps({"command": "python -m unittest tests.test_queue"})}}]),
                message("tool-3", "tool", "BEFORE EDIT: Ran 4 tests. OK. Exit code 0.", tool_call_id="call-old"),
                message("tool-4", "assistant", "I changed the queue admission guard. Checking the updated tests now.", tool_calls=[{"id": "call-new", "type": "function", "function": {"name": "shell", "arguments": json.dumps({"command": "python -m unittest tests.test_queue"})}}]),
                message("tool-5", "tool", "AFTER EDIT: FAIL: test_reject_after_close (tests.test_queue.QueueTests). AssertionError: expected QueueClosed, got None at src/queue.py:41. Ran 4 tests. FAILED (failures=1). Exit code 1.", tool_call_id="call-new"),
                message("tool-6", "assistant", "The updated test run failed. I have not applied a fix since that run."),
                message("tool-7", "user", "Continue the diagnosis and keep the tool evidence attached to its command."),
                message("tool-8", "assistant", "I will inspect the admission branch around the reported line."),
            ], ["tool-1"],
            "Did the most recent test run pass, which test failed, what unexpected value was returned, and where?",
            [["fail"], ["test_reject_after_close"], ["none"], ["src/queue.py:41", "src/queue.py line 41", "src/queue.py, line 41"]],
            ["most recent test run passed", "latest test run passed"], ["tool-4", "tool-5", "tool-6"],
        ),
        noise_case(),
        case(
            "unknown-state", "abstention", "Prepare a deployment-readiness note based only on observed local evidence.",
            [
                message("abs-1", "user", "Prepare the readiness note; do not infer production status from local checks."),
                message("abs-2", "assistant", "A local formatter check passed. No staging or production rollout was performed. No deployment version or production smoke-test result is present in this session."),
                message("abs-3", "user", "Use the available evidence only."),
                message("abs-4", "assistant", "I will list the formatter result and the outstanding rollout validation."),
            ], ["abs-1", "abs-2"],
            "What exact build is deployed in production, and did its production smoke test pass?",
            [], ["smoke test passed", "production test passed"], ["abs-2"], abstain=True,
        ),
    ]


def noise_case():
    messages = [
        message("noise-1", "user", "Finish the bounded worker queue. Queue capacity must remain 64 and enqueue must raise QueueFull rather than discard tasks."),
        message("noise-2", "assistant", "Accepted queue decision: capacity 64, reject excess work with QueueFull. The relevant regression is test_capacity_boundary in tests/test_worker.py."),
    ]
    topics = [
        "A speculative redesign of an unrelated gallery considers beige backgrounds, large serif titles, image captions and a carousel. None of these ideas change the worker queue.",
        "An unrelated travel planning example compares train routes, walking times, museum opening schedules, lunch menus and weekend weather. This is filler conversation outside the coding task.",
        "An old experiment explored sorting reading lists alphabetically, filtering bookmarks, choosing icons, displaying article cards and exporting a reading queue. It was never part of the bounded worker implementation.",
    ]
    for index in range(24):
        messages.append(message(f"noise-{index + 3}", "assistant" if index % 2 else "user", f"Archived side discussion {index + 1}: " + " ".join([topics[index % len(topics)]] * 5)))
    messages.extend([
        message("noise-27", "user", "Return to the bounded worker queue; keep the original accepted queue behavior and find the relevant regression test."),
        message("noise-28", "assistant", "I am ready to resume the original implementation after the unrelated discussions."),
    ])
    return case(
        "irrelevant-noise", "irrelevant_noise", "Finish the bounded worker queue and locate its capacity regression test.",
        messages, ["noise-1"],
        "What capacity and overload behavior were accepted, and which regression test and file are relevant?",
        [["64"], ["queuefull"], ["test_capacity_boundary"], ["tests/test_worker.py"]],
        [], ["noise-1", "noise-2"],
    )


if __name__ == "__main__":
    destination = Path(__file__).with_name("fixtures.json")
    destination.write_text(json.dumps(fixtures(), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote 6 synthetic cases to {destination}")
