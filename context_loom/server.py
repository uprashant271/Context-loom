"""TLS loopback worker. Inputs stay in RAM; no transcript logging or disk cache."""
from __future__ import annotations
from collections import deque
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import hashlib
from pathlib import Path
import secrets
import ssl
import threading
import time
from urllib.parse import urlsplit

from .core import Config, plan, compact
from .providers import LocalSummarizer

MAX_BODY = 1_000_000
ALLOWED_CONFIG = {"target_tokens", "summary_reserve_tokens", "recent_turns", "max_source_tokens", "protect_user_messages", "summary_max_chars"}

def validate_payload(data):
    if not isinstance(data, dict) or set(data) - {"messages", "task", "pins", "config"}:
        raise ValueError("Expected messages, task, optional pins and config")
    messages = data.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 200:
        raise ValueError("Expected 1..200 messages")
    if not isinstance(data.get("task"), str) or not 1 <= len(data["task"]) <= 8000:
        raise ValueError("Task must contain 1..8000 characters")
    pins = data.get("pins", [])
    if not isinstance(pins, list) or len(pins) > 200:
        raise ValueError("Pins must be a list")
    options = data.get("config", {})
    if not isinstance(options, dict): raise ValueError("Config must be an object")
    options = {key: value for key, value in options.items() if key in ALLOWED_CONFIG}
    if data.get("config", {}).get("recent_messages") is not None:
        options["recent_turns"] = data["config"]["recent_messages"]
    cfg = Config(**options)
    if cfg.target_tokens > 200000 or cfg.max_source_tokens > 24000 or cfg.recent_turns > 40:
        raise ValueError("Configured budget exceeds worker limits")
    for message in messages:
        if not isinstance(message, dict) or len(json.dumps(message)) > 120000:
            raise ValueError("Invalid or oversized message")
    return messages, data["task"], pins, cfg

def serve(port, cert, key, token, ranker_name, tls_password=None):
    from .cli import runtime, ROOT
    ranker, counter = runtime(ranker_name)
    summarizer = LocalSummarizer(counter=counter)
    lock = threading.Lock()
    requests = deque()
    snapshots = {}
    sessions = {}
    origin = f"https://localhost:{port}"
    static = ROOT / "site" / "dist"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def response(self, status, body, content_type="application/json", cookie=None):
            raw = json.dumps(body).encode() if content_type == "application/json" else body
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            if cookie: self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(raw)

        def host_valid(self):
            return self.headers.get("Host") in {f"localhost:{port}", f"127.0.0.1:{port}"}

        def authenticated(self):
            bearer = self.headers.get("Authorization", "")
            if secrets.compare_digest(bearer.encode("utf-8"), ("Bearer " + token).encode("utf-8")): return True
            if self.headers.get("Origin") != origin: return False
            cookie = SimpleCookie()
            try: cookie.load(self.headers.get("Cookie", ""))
            except Exception: return False
            sid = cookie.get("loom")
            if not sid: return False
            issued = sessions.get(sid.value)
            if issued is None or time.monotonic() - issued > 3600: return False
            sessions[sid.value] = time.monotonic()
            return True

        def do_GET(self):
            if not self.host_valid(): return self.response(403, {"error":"Untrusted host"})
            path = urlsplit(self.path).path
            if path == "/health": return self.response(200, {"status":"ready", "ranker":ranker.name,"counter":counter.kind,"worker_fingerprint":hashlib.sha256(token.encode()).hexdigest()})
            if path.startswith("/v1/recall/"):
                if not self.authenticated(): return self.response(401, {"error":"Authentication required"})
                snapshot = snapshots.get(path.split("/")[-1])
                if not snapshot or time.monotonic() - snapshot[0] > 3600:
                    return self.response(404, {"error":"Snapshot expired or unavailable"})
                return self.response(200, {"messages":snapshot[1],"retention":"in_memory_60_minutes"})
            relative = "index.html" if path == "/" else path.lstrip("/")
            file = (static / relative).resolve()
            if not file.is_relative_to(static.resolve()) or not file.is_file():
                return self.response(404, {"error":"Not found"})
            types = {".html":"text/html; charset=utf-8", ".css":"text/css", ".js":"text/javascript", ".json":"application/json", ".zip":"application/zip"}
            cookie = None
            if path == "/":
                sid = secrets.token_urlsafe(32)
                now = time.monotonic()
                for old, created in list(sessions.items()):
                    if now - created > 3600: sessions.pop(old, None)
                if len(sessions) >= 100: sessions.pop(next(iter(sessions)))
                sessions[sid] = now
                cookie = f"loom={sid}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600; Path=/"
            return self.response(200, file.read_bytes(), types.get(file.suffix,"application/octet-stream"), cookie)

        def do_POST(self):
            if not self.host_valid(): return self.response(403, {"error":"Untrusted host"})
            if not self.authenticated(): return self.response(401, {"error":"Authentication required"})
            if self.path not in {"/v1/plan", "/v1/compact"}: return self.response(404, {"error":"Not found"})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.response(415, {"error":"Use application/json"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= MAX_BODY: return self.response(413, {"error":"Input must be 1..1000000 bytes"})
                self.connection.settimeout(10)
                payload = json.loads(self.rfile.read(length))
                messages, task, pins, cfg = validate_payload(payload)
            except (ValueError, TypeError, RecursionError, OSError):
                return self.response(400, {"error":"Invalid transcript or configuration"})
            if not lock.acquire(blocking=False): return self.response(409, {"error":"Inference busy; retry after current request"})
            try:
                now = time.monotonic()
                while requests and now - requests[0] > 60: requests.popleft()
                if len(requests) >= 10: return self.response(429, {"error":"Limit is 10 requests per minute"})
                requests.append(now)
                common = dict(messages=messages, task=task, pins=pins, config=cfg, ranker=ranker, counter=counter)
                result = plan(**common) if self.path == "/v1/plan" else compact(**common, summarizer=summarizer)
                if len(snapshots) >= 16: snapshots.pop(next(iter(snapshots)))
                for old, record in list(snapshots.items()):
                    if now - record[0] > 3600: snapshots.pop(old, None)
                snapshot_id = secrets.token_urlsafe(18)
                snapshots[snapshot_id] = (now, messages)
                result["snapshot_id"] = snapshot_id
                result["retrieval"] = {"expires_in_seconds":3600,"storage":"worker_memory","survives_restart":False}
                return self.response(200, result)
            except Exception:
                return self.response(422, {"error":"Compaction validation or model failed; original context remains available"})
            finally: lock.release()

    class TLSHTTPServer(ThreadingHTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(5)
            try: connection.do_handshake()
            except OSError:
                connection.close()
                raise
            return connection, address

    server = TLSHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert), str(key), password=tls_password)
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    print(f"Context Loom worker ready: {origin}", flush=True)
    try: server.serve_forever()
    finally: server.server_close()
