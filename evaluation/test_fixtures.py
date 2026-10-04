"""Validate authored benchmark inputs without importing models or calling providers."""
import json
from pathlib import Path
import unittest

FIXTURES = Path(__file__).with_name("fixtures.json")


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads(FIXTURES.read_text(encoding="utf-8"))

    def test_six_distinct_synthetic_cases(self):
        self.assertEqual(6, len(self.cases))
        self.assertEqual(6, len({case["id"] for case in self.cases}))
        for case in self.cases:
            self.assertEqual("synthetic", case["source"])
            self.assertTrue(case["task"].strip())

    def test_message_ids_roles_and_pin_references(self):
        for case in self.cases:
            with self.subTest(case=case["id"]):
                ids = [message["id"] for message in case["messages"]]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertTrue(set(case["pins"]).issubset(ids))
                for message in case["messages"]:
                    self.assertIn(message["role"], {"user", "assistant", "tool", "system"})
                    self.assertIsInstance(message["content"], str)

    def test_tool_results_have_preceding_calls(self):
        for case in self.cases:
            pending = set()
            for message in case["messages"]:
                for call in message.get("tool_calls", []):
                    self.assertNotIn(call["id"], pending)
                    pending.add(call["id"])
                if message["role"] == "tool":
                    self.assertIn(message["tool_call_id"], pending)
                    pending.remove(message["tool_call_id"])
            self.assertFalse(pending)

    def test_evaluation_expectations_are_separate(self):
        for case in self.cases:
            self.assertNotIn("evaluation", {
                "messages": case["messages"], "task": case["task"], "pins": case["pins"]
            })
            question = case["evaluation"]
            self.assertNotEqual(question["question"], case["task"])
            self.assertTrue(question["required"] or question.get("expected_abstain"))
            ids = {message["id"] for message in case["messages"]}
            self.assertTrue(set(question["evidence_ids"]).issubset(ids))
            for alternatives in question["required"]:
                self.assertIsInstance(alternatives, list)
                self.assertTrue(all(isinstance(value, str) and value for value in alternatives))

    def test_scope_and_difficulties_are_declared(self):
        required = {"correction", "exact_identifiers", "pending_work", "tool_evidence", "irrelevant_noise", "abstention"}
        self.assertTrue(required.issubset({case["difficulty"] for case in self.cases}))
        for case in self.cases:
            self.assertEqual("synthetic_qa_retention", case["evaluation_scope"])


if __name__ == "__main__":
    unittest.main()
