"""Stdlib worker checks: lexical fixtures only; no LLM/model loading or history.

Run from the source checkout with python -m unittest discover -s tests -p test_server.py.
"""
from __future__ import annotations
import copy
import http.client
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from context_loom.cli import certificates, main
from context_loom.server import validate_payload

FIXTURE = {"messages": [{"id": "m0", "role": "user", "content": "Preserve synthetic endpoint /fixture/v1."},
                         {"id": "m1", "role": "assistant", "content": "The obsolete experiment is closed."}],
           "task": "Fix synthetic BUG-123 while retaining the accepted public API.",
           "pins": ["m0"], "config": {"target_tokens": 2000, "summary_reserve_tokens": 256, "recent_messages": 1}}


class PayloadValidationTests(unittest.TestCase):
    def test_valid_adapter_config_translates_recent_messages_without_mutation(self):
        original = copy.deepcopy(FIXTURE)
        _, _, pins, config = validate_payload(FIXTURE)
        self.assertEqual(config.recent_turns, 1)
        self.assertEqual(pins, ["m0"])
        self.assertEqual(FIXTURE, original)

    def test_rejects_hostile_envelopes_and_oversized_requests(self):
        values = [None, [], {}, {**FIXTURE, "extra": "unexpected"}, {**FIXTURE, "messages": []},
                  {**FIXTURE, "messages": [{}] * 201}, {**FIXTURE, "messages": ["not an object"]},
                  {**FIXTURE, "task": ""}, {**FIXTURE, "task": "x" * 8001},
                  {**FIXTURE, "pins": "m0"}, {**FIXTURE, "config": []},
                  {**FIXTURE, "messages": [{"content": "x" * 120001}]}]
        for value in values:
            with self.subTest(shape=type(value).__name__):
                with self.assertRaises((ValueError, TypeError)):
                    validate_payload(value)

    def test_rejects_invalid_numeric_budgets_and_worker_limit_overrides(self):
        for config in ({"target_tokens": True}, {"target_tokens": 0}, {"target_tokens": 200001},
                       {"max_source_tokens": 24001}, {"recent_messages": 41},
                       {"summary_reserve_tokens": float("nan")}, {"recent_turns": -1}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                validate_payload({**FIXTURE, "config": config})


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL is needed for isolated localhost TLS fixture")
class TLSWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="loom-worker-test-")
        cls.state = Path(cls.directory.name)
        cls.cert, cls.key, password = certificates(cls.state)
        cls.token = secrets.token_urlsafe(32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.context = ssl.create_default_context(cafile=str(cls.cert))
        env = dict(os.environ, CONTEXT_LOOM_WORKER_TOKEN=cls.token, CONTEXT_LOOM_TLS_PASSWORD=password)
        env["PYTHONPATH"] = str(ROOT)
        cls.worker = subprocess.Popen([sys.executable, "-m", "context_loom", "serve", "--ranker", "lexical",
                                       "--port", str(cls.port), "--state", str(cls.state)], cwd=ROOT, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if cls.worker.poll() is not None:
                cls.directory.cleanup()
                raise RuntimeError("Lexical TLS fixture worker exited during startup")
            try:
                status, _, _ = cls.request("GET", "/health")
                if status == 200: return
            except (OSError, http.client.HTTPException): pass
            time.sleep(.05)
        cls.worker.terminate()
        cls.worker.wait(timeout=5)
        cls.directory.cleanup()
        raise RuntimeError("Lexical TLS fixture worker did not become ready")

    @classmethod
    def tearDownClass(cls):
        cls.worker.terminate()
        try: cls.worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.worker.kill()
            cls.worker.wait(timeout=5)
        cls.directory.cleanup()

    @classmethod
    def request(cls, method, path, payload=None, headers=None, context=None):
        connection = http.client.HTTPSConnection("localhost", cls.port, context=context or cls.context, timeout=5)
        body = json.dumps(payload).encode() if payload is not None else None
        supplied = dict(headers or {})
        if body is not None: supplied.setdefault("Content-Type", "application/json")
        try:
            connection.request(method, path, body=body, headers=supplied)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw
        finally: connection.close()

    def test_certificate_is_encrypted_and_client_verification_remains_enabled(self):
        self.assertIn("BEGIN ENCRYPTED PRIVATE KEY", self.key.read_text())
        self.assertEqual(self.key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(self.context.check_hostname)
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.request("GET", "/health", context=ssl.create_default_context())

    def test_health_has_labeled_lexical_runtime_and_host_binding(self):
        status, headers, raw = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["ranker"], "lexical-overlap-baseline")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("GET", "/health", headers={"Host": "evil.example"})[0], 403)

    def test_bearer_plan_and_recall_roundtrip_preserve_original_rows(self):
        self.assertEqual(self.request("POST", "/v1/plan", FIXTURE)[0], 401)
        auth = {"Authorization": "Bearer " + self.token}
        status, _, raw = self.request("POST", "/v1/plan", FIXTURE, auth)
        self.assertEqual(status, 200)
        plan = json.loads(raw)
        self.assertEqual(plan["status"], "ready")
        self.assertEqual(plan["ranker"], "lexical-overlap-baseline")
        self.assertEqual(plan["retrieval"]["expires_in_seconds"], 3600)
        self.assertFalse(plan["retrieval"]["survives_restart"])
        endpoint = "/v1/recall/" + plan["snapshot_id"]
        self.assertEqual(self.request("GET", endpoint)[0], 401)
        status, _, raw = self.request("GET", endpoint, headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["messages"], FIXTURE["messages"])
        self.assertEqual(self.request("GET", "/v1/recall/nonexistent", headers=auth)[0], 404)

    def test_browser_cookie_requires_exact_origin_and_sets_security_flags(self):
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"]
        for flag in ("HttpOnly", "Secure", "SameSite=Strict", "Max-Age=3600"):
            self.assertIn(flag, cookie)
        session_cookie = cookie.split(";", 1)[0]
        self.assertEqual(self.request("POST", "/v1/plan", FIXTURE, {"Cookie": session_cookie})[0], 401)
        self.assertEqual(self.request("POST", "/v1/plan", FIXTURE,
                                    {"Cookie": session_cookie, "Origin": "https://evil.example"})[0], 401)
        self.assertEqual(self.request("POST", "/v1/plan", FIXTURE,
                                    {"Cookie": session_cookie, "Origin": "https://localhost:" + str(self.port)})[0], 200)

    def test_assets_do_not_evict_the_authenticated_browser_session(self):
        _, headers, _ = self.request("GET", "/")
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        for _ in range(101):
            status, _, _ = self.request("GET", "/style.css")
            self.assertEqual(status, 200)
        self.assertEqual(self.request("POST", "/v1/plan", FIXTURE,
                                    {"Cookie": cookie, "Origin": "https://localhost:" + str(self.port)})[0], 200)

    def test_non_ascii_invalid_bearer_is_rejected_as_http_auth_failure(self):
        self.assertEqual(self.request("GET", "/v1/recall/nonexistent",
                                     headers={"Authorization": "Bearer caf\u00e9"})[0], 401)

    def test_low_uptime_auth_and_snapshot_eviction_expiry_and_rate_limits(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        # A separate lexical worker with an explicit synthetic monotonic clock
        # reproduces hosts whose uptime is below the cookie lifetime.
        state = Path(self.directory.name) / "low-uptime"
        cert, key, password = certificates(state)
        clock = state / "synthetic-clock.txt"
        clock.write_text("1000.0")
        env = dict(os.environ, CONTEXT_LOOM_WORKER_TOKEN=self.token,
                   CONTEXT_LOOM_TLS_PASSWORD=password, LOOM_TEST_PORT=str(port),
                   LOOM_TEST_CERT=str(cert), LOOM_TEST_KEY=str(key),
                   LOOM_TEST_CLOCK=str(clock), PYTHONPATH=str(ROOT))
        script = ("import os; from pathlib import Path; import context_loom.server as s; "
                  "s.time.monotonic=lambda:float(Path(os.environ['LOOM_TEST_CLOCK']).read_text()); "
                  "s.serve(int(os.environ['LOOM_TEST_PORT']),os.environ['LOOM_TEST_CERT'],"
                  "os.environ['LOOM_TEST_KEY'],os.environ['CONTEXT_LOOM_WORKER_TOKEN'],'lexical',"
                  "os.environ['CONTEXT_LOOM_TLS_PASSWORD'])")
        child = subprocess.Popen([sys.executable, "-c", script], env=env, cwd=ROOT,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        context = ssl.create_default_context(cafile=str(cert))

        def local_request(method, path, payload=None, headers=None):
            connection = http.client.HTTPSConnection("localhost", port, context=context, timeout=5)
            try:
                supplied = dict(headers or {})
                body = json.dumps(payload) if payload is not None else None
                if body is not None: supplied["Content-Type"] = "application/json"
                connection.request(method, path, body=body, headers=supplied)
                response = connection.getresponse()
                return response.status, response.read()
            finally: connection.close()

        try:
            deadline = time.monotonic() + 10
            while True:
                connection = http.client.HTTPSConnection("localhost", port, context=context, timeout=2)
                try:
                    connection.request("GET", "/health")
                    connection.getresponse().read()
                    break
                except (OSError, http.client.HTTPException):
                    if child.poll() is not None or time.monotonic() >= deadline:
                        self.fail("Low-uptime fixture did not become ready")
                    time.sleep(.05)
                finally: connection.close()
            self.assertEqual(local_request("POST", "/v1/plan", FIXTURE,
                {"Cookie": "loom=never-issued", "Origin": "https://localhost:" + str(port)})[0], 401)
            auth = {"Authorization": "Bearer " + self.token}
            created = []
            for index in range(17):
                clock.write_text(str(1000 + 61 * index))
                status, raw = local_request("POST", "/v1/plan", FIXTURE, auth)
                self.assertEqual(status, 200)
                created.append(json.loads(raw)["snapshot_id"])
            self.assertEqual(local_request("GET", "/v1/recall/" + created[0], headers=auth)[0], 404,
                             "the 17th snapshot evicts the oldest of 16 RAM entries")
            self.assertEqual(local_request("GET", "/v1/recall/" + created[-1], headers=auth)[0], 200)
            clock.write_text(str(1000 + 61 * 16 + 3601))
            self.assertEqual(local_request("GET", "/v1/recall/" + created[-1], headers=auth)[0], 404,
                             "snapshot access expires after 60 minutes without wall-clock waiting")
            for _ in range(10):
                self.assertEqual(local_request("POST", "/v1/plan", FIXTURE, auth)[0], 200)
            self.assertEqual(local_request("POST", "/v1/plan", FIXTURE, auth)[0], 429)
        finally:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    def test_malformed_graph_and_excess_body_limit_are_rejected(self):
        auth = {"Authorization": "Bearer " + self.token}
        duplicate = {**FIXTURE, "messages": [FIXTURE["messages"][0], FIXTURE["messages"][0]]}
        self.assertIn(self.request("POST", "/v1/plan", duplicate, auth)[0], (400, 422))
        incomplete = {**FIXTURE, "messages": [{"id": "m0", "role": "assistant", "content": "",
                                               "tool_calls": [{"id": "c0", "name": "fixture"}]}], "pins": []}
        self.assertIn(self.request("POST", "/v1/plan", incomplete, auth)[0], (400, 422))
        self.assertEqual(self.request("POST", "/v1/plan", None,
                                     {**auth, "Content-Type": "application/json", "Content-Length": "1000001"})[0], 413)

    def test_attach_launcher_injects_only_needed_secrets_preserves_ca_and_cleans_state(self):
        base = Path(self.directory.name) / "launcher-fixture"
        base.mkdir()
        executable = base / "synthetic-claude"
        result_path = base / "checks.json"
        executable.write_text("#!" + sys.executable + "\n" +
            "import json, os, sys\nfrom pathlib import Path\n"
            "if '--version' in sys.argv:\n print('2.1.288 (synthetic CLI fixture)'); sys.exit(0)\n"
            "bundle=Path(os.environ['NODE_EXTRA_CA_CERTS'])\n"
            "checks={'token_injected':len(os.environ.get('CONTEXT_LOOM_WORKER_TOKEN',''))>=32,"
            "'tls_password_absent':'CONTEXT_LOOM_TLS_PASSWORD' not in os.environ,"
            "'verified_loopback_url':os.environ.get('CONTEXT_LOOM_WORKER_URL','').startswith('https://localhost:'),"
            "'plugin_argument':'--plugin-dir' in sys.argv,"
            "'combined_ca':bundle.read_text().count('BEGIN CERTIFICATE')==2}\n"
            "Path(os.environ['LOOM_TEST_CHECKS']).write_text(json.dumps(checks))\n")
        executable.chmod(0o700)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {"NODE_EXTRA_CA_CERTS": str(self.cert), "LOOM_TEST_CHECKS": str(result_path),
               "PYTHONPATH": str(ROOT),
               "CONTEXT_LOOM_TLS_PASSWORD": "inherited-test-marker-must-not-reach-agent"}
        with tempfile.TemporaryFile(mode="w+") as stderr, patch.dict(os.environ, env), patch("sys.stderr", stderr):
            result = main(["attach", "--ranker", "lexical", "--port", str(port),
                           "--state", str(base), "--claude", str(executable), "--", "--synthetic-agent-argument"])
            stderr.seek(0)
            diagnostic = stderr.read()
        self.assertEqual(result, 0, diagnostic)
        checks = json.loads(result_path.read_text())
        self.assertTrue(all(checks.values()), checks)
        self.assertEqual(list(base.glob("run-*")), [], "launcher removes ephemeral keys and CA bundle after agent exits")

    def test_attach_worker_spawn_failure_cleans_ephemeral_key_directory(self):
        base = Path(self.directory.name) / "failed-launcher-fixture"
        base.mkdir()
        executable = base / "synthetic-claude"
        executable.write_text("#!" + sys.executable + "\nprint('2.1.288 (synthetic CLI fixture)')\n")
        executable.chmod(0o700)
        native_popen = subprocess.Popen
        failed_worker_spawns = []

        def fail_worker_only(command, *args, **kwargs):
            if "context_loom" in command and "serve" in command:
                failed_worker_spawns.append(command)
                raise OSError("synthetic spawn failure")
            return native_popen(command, *args, **kwargs)

        with patch("context_loom.cli.subprocess.Popen", side_effect=fail_worker_only), patch("sys.stderr", io.StringIO()):
            result = main(["attach", "--ranker", "lexical", "--state", str(base), "--claude", str(executable)])
        self.assertEqual(result, 2)
        self.assertEqual(len(failed_worker_spawns), 1)
        self.assertEqual(list(base.glob("run-*")), [])


if __name__ == "__main__":
    unittest.main()
