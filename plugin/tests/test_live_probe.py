"""Executable probe regression with a fake stream-json CLI; no model or worker."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


class LiveProbeHarnessTest(unittest.TestCase):
    def test_full_probe_runs_and_reports_without_exposing_launch_credentials(self):
        with tempfile.TemporaryDirectory(prefix="loom-probe-harness-") as folder:
            cli = Path(folder) / "synthetic-cli"
            cli.write_text("#!" + sys.executable + "\n" + textwrap.dedent('''\
                import json, sys
                print(json.dumps({"type":"system","subtype":"init","model":"synthetic-model","claude_code_version":"2.1.288"}),flush=True)
                for line in sys.stdin:
                    event=json.loads(line)
                    prompt=event["message"]["content"]
                    print(json.dumps(event),flush=True)
                    if prompt.startswith("/loom-pin"):
                        text="Pinned verbatim: m0."
                    elif prompt=="/loom-compact":
                        text="Manual compaction queued for the next idle boundary."
                    elif prompt=="/loom-status":
                        text="Selected 6/6 messages; retained 5 original messages verbatim. Native LLM generated the summary.\\nHistorical snapshot: snapshot_123-abc (worker RAM; expires within 60 minutes)."
                        print(json.dumps({"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":321}}),flush=True)
                    elif prompt.startswith("/loom-recall"):
                        text="Historical transcript evidence: synthetic endpoint /fixture/v1."
                    elif prompt.startswith("Synthetic verification"):
                        text="Retain public API v1 and endpoint /fixture/v1; pending task BUG-123."
                    else:
                        text="fixture-recorded"
                    print(json.dumps({"type":"assistant","message":{"content":[{"type":"text","text":text}]}}),flush=True)
                    print(json.dumps({"type":"result","subtype":"success","is_error":False,"result":text,"usage":{"input_tokens":10,"cache_read_input_tokens":300},"total_cost_usd":0}),flush=True)
                '''))
            cli.chmod(0o700)
            env = dict(os.environ, CONTEXT_LOOM_WORKER_TOKEN="synthetic-only-test-credential",
                       NODE_EXTRA_CA_CERTS=str(Path(folder) / "unused-synthetic-ca.pem"))
            probe = Path(__file__).with_name("live_probe.py")
            result = subprocess.run([sys.executable, str(probe), "--claude", str(cli), "--timeout", "5"],
                                    env=env, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(env["CONTEXT_LOOM_WORKER_TOKEN"], result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertTrue(report["custom_synthetic_system_prompt"])
            self.assertTrue(report["not_a_benchmark"])
            self.assertTrue(report["custom_compaction_reported"])
            self.assertTrue(report["snapshot_recall_attempted"])
            self.assertTrue(report["constraint_identifier_in_answer"])
            self.assertEqual(report["host"]["model"], "synthetic-model")
            self.assertEqual(report["compact_boundaries"][0]["pre_tokens"], 321)
            self.assertEqual(len(report["echoed_user_messages"]), 9)
            self.assertEqual(len(report["turns"]), 9)


if __name__ == "__main__":
    unittest.main()
