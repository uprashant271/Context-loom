"""Checks for benchmark fairness and scoring; no inference is needed."""
import json
import unittest

import run


class FakeCounter:
    kind = "fixture_word_counter"

    def count_messages(self, messages):
        return sum(len(message["content"].split()) + 1 for message in messages)


class RunnerTests(unittest.TestCase):
    def test_future_evaluation_fields_never_reach_compactor(self):
        case = {"messages": [{"id": "a", "role": "user", "content": "Current work"}], "task": "Current task", "pins": ["a"], "evaluation": {"question": "Future test question", "answer": "Secret expected answer"}}
        inputs = run.compactor_inputs(case)
        self.assertEqual({"messages", "task", "pins"}, set(inputs))
        self.assertNotIn("Future test question", json.dumps(inputs))
        self.assertNotIn("Secret expected answer", json.dumps(inputs))
        inputs["messages"][0]["content"] = "modified"
        self.assertEqual("Current work", case["messages"][0]["content"])

    def test_recency_does_not_orphan_tool_result(self):
        messages = [
            {"id": "old", "role": "user", "content": "An earlier task"},
            {"id": "call", "role": "assistant", "content": "Run tests", "tool_calls": [{"id": "c1"}]},
            {"id": "result", "role": "tool", "content": "Tests failed", "tool_call_id": "c1"},
            {"id": "latest", "role": "assistant", "content": "Continue"},
        ]
        artifact = run.recency_baseline(messages, [], 5, FakeCounter())
        ids = {message["id"] for message in artifact["replacement_messages"]}
        self.assertFalse("result" in ids and "call" not in ids)
        self.assertLessEqual(artifact["compacted_tokens"], 5)

    def test_pinned_tool_result_preserves_call_as_well(self):
        messages = [
            {"id": "call", "role": "assistant", "content": "Run", "tool_calls": [{"id": "c1"}]},
            {"id": "result", "role": "tool", "content": "Failed", "tool_call_id": "c1"},
        ]
        artifact = run.recency_baseline(messages, ["result"], 4, FakeCounter())
        self.assertEqual(["call", "result"], [message["id"] for message in artifact["replacement_messages"]])

    def test_pins_over_budget_block_instead_of_dropping(self):
        artifact = run.recency_baseline([{"id": "pin", "role": "user", "content": "Preserve these exact user constraints"}], ["pin"], 2, FakeCounter())
        self.assertEqual("blocked", artifact["status"])

    def test_grading_checks_all_fields_and_abstention(self):
        expected = {"required": [["lookup_task"], ["45 minutes", "45-minute"]], "forbidden": ["production smoke test passed"], "expected_abstain": False}
        self.assertTrue(run.grade_answer({"answer": "lookup_task uses a 45-minute expiry", "abstain": False}, expected)["passed"])
        self.assertFalse(run.grade_answer({"answer": "lookup_task uses 10 minutes", "abstain": False}, expected)["passed"])
        self.assertFalse(run.grade_answer({"answer": "lookup_task, 45 minutes; production smoke test passed", "abstain": False}, expected)["passed"])
        self.assertFalse(run.grade_answer({"answer": "lookup_task, 45 minutes", "abstain": True}, expected)["passed"])

    def test_malformed_reader_response_is_not_a_pass(self):
        with self.assertRaises(ValueError):
            run.grade_answer({"answer": "known answer", "abstain": "false"}, {"required": [], "forbidden": [], "expected_abstain": False})

    def test_pipeline_failures_and_completed_answer_accuracy_are_separate(self):
        grade = {"passed": True, "required_fields_total": 2, "required_fields_matched": 2}
        records = [
            {"method": "hybrid", "status": "compacted", "grade": grade, "compaction_seconds": 1, "reader_seconds": 2},
            {"method": "hybrid", "status": "blocked", "compaction_seconds": 3},
        ]
        metric = run.aggregate(records)[0]
        self.assertEqual(0.5, metric["pass_fraction"])
        self.assertEqual(1, metric["qa_pass_fraction_completed_only"])
        self.assertEqual(1, metric["failed_or_blocked_cases"])


if __name__ == "__main__":
    unittest.main()
