"""Source-checkout launcher and standalone engine entry points."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request

from .core import Config, TokenCounter, HeuristicRanker, plan, compact
from .rankers import QwenRanker
from .providers import ClaudeSummarizer, LocalSummarizer

ROOT = Path(__file__).resolve().parents[1]

def runtime(ranker_name):
    if ranker_name == "lexical":
        return HeuristicRanker(), TokenCounter()
    ranker = QwenRanker(device=os.environ.get("CONTEXT_LOOM_DEVICE", "auto"))
    ranker._load()
    return ranker, TokenCounter(ranker.tokenizer, ranker.name)

def certificates(state):
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    cert, key = state / "localhost.pem", state / "localhost-key.pem"
    password = secrets.token_urlsafe(40)
    # Rotate on each launch. The private PEM is encrypted; its password exists
    # only in this process and the worker child environment, never on disk.
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-days", "1", "-keyout", str(key), "-out", str(cert), "-passout", "stdin", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], input=password+'\n', text=True, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    key.chmod(0o600)
    cert.chmod(0o600)
    return cert, key, password

def main(argv=None):
    parser = argparse.ArgumentParser(description="Context Loom — select evidence, preserve state, summarize with an LLM")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "compact"):
        p = sub.add_parser(name)
        p.add_argument("input", help="JSON file containing messages, task, optional pins/config")
        p.add_argument("--ranker", choices=["qwen", "lexical"], default="qwen")
        p.add_argument("--model", default=None, help="Claude model for summarization")
        p.add_argument("--summary-provider", choices=["local", "claude"], default="local")
    for name in ("serve", "attach", "playground"):
        p = sub.add_parser(name)
        p.add_argument("--port", type=int, default=8787)
        p.add_argument("--ranker", choices=["qwen", "lexical"], default="qwen")
        p.add_argument("--state", default=str(ROOT / ".loom"))
        if name == "attach":
            p.add_argument("--claude", default="claude", help="Executable path; requires Claude Code 2.1.287+")
            p.add_argument("agent_args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    ephemeral_state = None
    try:
        if args.command in {"plan", "compact"}:
            data = json.loads(Path(args.input).read_text())
            ranker, counter = runtime(args.ranker)
            config = Config(**data.get("config", {}))
            common = dict(messages=data["messages"], task=data["task"], pins=data.get("pins", []), config=config, ranker=ranker, counter=counter)
            summarizer = LocalSummarizer(model_path=args.model or "Qwen/Qwen3-0.6B", counter=counter) if args.summary_provider == "local" else ClaudeSummarizer(model=args.model, counter=counter)
            result = plan(**common) if args.command == "plan" else compact(**common, summarizer=summarizer)
            print(json.dumps(result, indent=2))
            return 0 if result["status"] in {"ready", "compacted"} else 2
        if not 1024 <= args.port <= 65535:
            raise ValueError("Port must be 1024..65535")
        state = Path(args.state).resolve()
        if args.command == "attach":
            cli = shutil.which(args.claude) or args.claude
            version = subprocess.run([cli, "--version"], capture_output=True, text=True, check=True).stdout
            import re
            match = re.search(r"(\d+)\.(\d+)\.(\d+)", version)
            if not match or tuple(map(int, match.groups())) < (2, 1, 287):
                raise ValueError("Claude Code 2.1.287+ is required. Use --claude PATH for an isolated compatible CLI.")
        if args.command in {"attach", "playground"}:
            state = state / ("run-" + secrets.token_hex(8))
            ephemeral_state = state
            cert, key, password = certificates(state)
        else:
            cert, key = state / "localhost.pem", state / "localhost-key.pem"
            password = os.environ.get("CONTEXT_LOOM_TLS_PASSWORD")
            if not password: raise ValueError("Worker requires CONTEXT_LOOM_TLS_PASSWORD from launcher")
        if args.command == "serve":
            from .server import serve
            token = os.environ.get("CONTEXT_LOOM_WORKER_TOKEN")
            if not token or len(token) < 32:
                raise ValueError("Set CONTEXT_LOOM_WORKER_TOKEN to a random secret of at least 32 characters")
            serve(args.port, cert, key, token, args.ranker, password)
            return 0
        if args.command == "playground":
            from .server import serve
            print(f"Local playground: https://localhost:{args.port}\nLocal CA: {cert}\nTrust this generated localhost certificate in a dedicated browser profile to use the playground. No system trust is changed automatically.", file=sys.stderr)
            try: serve(args.port, cert, key, secrets.token_urlsafe(32), args.ranker, password)
            except KeyboardInterrupt: return 0
            finally: shutil.rmtree(state, ignore_errors=True)
            return 0
        token = secrets.token_urlsafe(32)
        bundle = state / "trust-bundle.pem"
        trust = cert.read_bytes()
        existing_ca = os.environ.get("NODE_EXTRA_CA_CERTS")
        if existing_ca:
            previous = Path(existing_ca)
            if previous.stat().st_size > 8_000_000: raise ValueError("Existing CA bundle exceeds size limit")
            trust += b'\n' + previous.read_bytes()
        bundle.write_bytes(trust)
        env = dict(os.environ, CONTEXT_LOOM_WORKER_TOKEN=token, CONTEXT_LOOM_WORKER_URL=f"https://localhost:{args.port}", NODE_EXTRA_CA_CERTS=str(bundle))
        env.pop("CONTEXT_LOOM_TLS_PASSWORD", None)
        worker_env = dict(env, CONTEXT_LOOM_TLS_PASSWORD=password)
        worker = subprocess.Popen([sys.executable, "-m", "context_loom", "serve", "--port", str(args.port), "--state", str(state), "--ranker", args.ranker], env=worker_env, stdout=subprocess.DEVNULL, stderr=sys.stderr)
        try:
            ctx = ssl.create_default_context(cafile=str(cert))
            ready = False
            for _ in range(300):
                if worker.poll() is not None:
                    raise RuntimeError("Worker exited before readiness")
                try:
                    with urllib.request.urlopen(f"https://localhost:{args.port}/health", context=ctx, timeout=1) as response:
                        health = json.load(response)
                        ready = response.status == 200 and health.get("worker_fingerprint") == hashlib.sha256(token.encode()).hexdigest()
                    if ready: break
                except (OSError, ValueError):
                    time.sleep(1)
            if not ready: raise RuntimeError("Worker initialization exceeded five minutes")
            print(f"Context Loom ready · local playground: https://localhost:{args.port}", file=sys.stderr)
            extra = args.agent_args[1:] if args.agent_args[:1] == ["--"] else args.agent_args
            return subprocess.call([cli, "--plugin-dir", str(ROOT / "plugin"), *extra], env=env)
        finally:
            worker.terminate()
            try: worker.wait(timeout=10)
            except subprocess.TimeoutExpired: worker.kill()
            shutil.rmtree(state, ignore_errors=True)
    except (ValueError, KeyError, TypeError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print("Context Loom: " + type(error).__name__ + ". Check command options, local dependencies, and provider authentication.", file=sys.stderr)
        return 2
    finally:
        if ephemeral_state is not None: shutil.rmtree(ephemeral_state, ignore_errors=True)

if __name__ == "__main__":
    raise SystemExit(main())
