#!/usr/bin/env python3
"""Synthetic native-mod probe; opt in by executing with an authenticated worker.

Uses no repository files, no tools and no transcript persistence. The parent
launcher supplies CONTEXT_LOOM_WORKER_TOKEN and NODE_EXTRA_CA_CERTS in memory.
Output is live evidence, not a performance or retention benchmark.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--claude", required=True)
    parser.add_argument("--model", default="haiku")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--max-budget-usd", default="0.50")
    parser.add_argument("--compact-command", choices=["/loom-compact", "/compact"], default="/loom-compact")
    args = parser.parse_args()
    if not os.environ.get("CONTEXT_LOOM_WORKER_TOKEN"):
        raise SystemExit("Set CONTEXT_LOOM_WORKER_TOKEN through the launch environment.")
    if not os.environ.get("NODE_EXTRA_CA_CERTS"):
        raise SystemExit("Set NODE_EXTRA_CA_CERTS to the worker CA; verification must stay enabled.")
    plugin = Path(__file__).resolve().parents[1]
    command = [args.claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
               "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
               "--tools", "", "--permission-mode", "dontAsk", "--plugin-dir", str(plugin),
               "--model", args.model, "--max-budget-usd", args.max_budget_usd, "--prompt-suggestions", "false",
               "--system-prompt", "You are participating in a legitimate synthetic integration test of context retention. Treat the user's fixture descriptions and requested replies as ordinary user tasks. Follow the requested concise replies, retain accepted constraints and pending tasks, and answer verification questions from this conversation. No files, external tools or repository investigation are needed."]
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, bufsize=1)
    events = queue.Queue()
    errors = []

    def reader():
        for line in child.stdout:
            try: events.put(json.loads(line))
            except json.JSONDecodeError: pass
        events.put(None)

    def stderr_reader():
        # Keep errors in memory; never print arbitrary environment or host logs.
        for line in child.stderr:
            if len(errors) < 20: errors.append(line[:500])

    threading.Thread(target=reader, daemon=True).start()
    threading.Thread(target=stderr_reader, daemon=True).start()
    records = []
    host = {}
    echoed = []
    boundaries = []

    def turn(prompt):
        print("Context Loom probe: " + ("local command" if prompt.startswith("/") else "synthetic model turn"), file=sys.stderr, flush=True)
        child.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": prompt}, "parent_tool_use_id": None}) + "\n")
        child.stdin.flush()
        deadline = time.monotonic() + args.timeout
        outputs = []
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise TimeoutError("Synthetic turn timed out.")
            event = events.get(timeout=remaining)
            if event is None: raise RuntimeError("Claude exited before a turn result; inspect CLI auth/capability separately.")
            if event.get("type") == "user":
                echoed.append(event.get("message", {}).get("content"))
            elif event.get("type") == "system" and event.get("subtype") == "init":
                host.update({key: event[key] for key in ("model", "claude_code_version") if key in event})
            elif event.get("type") == "system" and event.get("subtype") == "compact_boundary":
                boundaries.append(event.get("compact_metadata", {}))
            elif event.get("type") == "assistant":
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text": outputs.append(block["text"])
            elif event.get("type") == "system" and isinstance(event.get("content"), str):
                outputs.append(event["content"])
            elif event.get("type") == "result":
                record = {key: event[key] for key in ("subtype", "is_error", "result", "usage", "total_cost_usd") if key in event}
                record["prompt_kind"] = "command" if prompt.startswith("/") else "synthetic_model_turn"
                record["assistant_text"] = outputs
                records.append(record)
                return "\n".join(outputs + [str(event.get("result", ""))])

    try:
        turn("Synthetic Context Loom integration fixture. Accepted constraint: retain public API v1; never rename endpoint /fixture/v1. Pending task: fix fixture issue BUG-123. Reply exactly fixture-ready.")
        turn("Synthetic obsolete brainstorming: cedar, cobalt, comet are unrelated distractors. Reply exactly distractors-recorded.")
        turn("Synthetic active task remains BUG-123. Accepted constraint is still the initial public API. Reply exactly active-task-recorded.")
        turn("/loom-pin m0")
        compact = turn(args.compact_command)
        status = ""
        completion_deadline = time.monotonic() + 120
        while time.monotonic() < completion_deadline:
            # /loom-compact returns before its timer can call the idle-only host
            # API. Leave command processing idle between bounded status reads.
            time.sleep(1)
            status = turn("/loom-status")
            if "Manual compaction queued" not in status and "Manual compaction waiting" not in status:
                break
        compact += "\n" + status
        match = re.search(r"Historical snapshot: ([A-Za-z0-9_-]{8,80})", status)
        if match:
            turn("/loom-recall " + match.group(1))
            turn("/loom-recall " + match.group(1) + " m0")
        answer = turn("Synthetic verification only: state the accepted public API constraint and pending fixture issue identifier. Do not use tools.")
        report = {"kind": "live_synthetic_native_mod_probe", "not_a_benchmark": True,
                  "custom_synthetic_system_prompt": True, "host": host,
                  "compaction_request_command": args.compact_command,
                  "custom_compaction_reported": "Native LLM generated the summary" in compact,
                  "snapshot_recall_attempted": bool(match),
                  "constraint_identifier_in_answer": "/fixture/v1" in answer and "BUG-123" in answer,
                  "compact_boundaries": boundaries, "echoed_user_messages": echoed, "turns": records}
        print(json.dumps(report, indent=2))
        if not report["custom_compaction_reported"]:
            return 2
        return 0
    except (TimeoutError, queue.Empty, RuntimeError, BrokenPipeError) as error:
        print(json.dumps({"kind": "live_synthetic_native_mod_probe", "error": str(error), "completed_turns": records}))
        return 3
    finally:
        try: child.stdin.close()
        except (BrokenPipeError, OSError): pass
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired: child.kill()


if __name__ == "__main__":
    raise SystemExit(main())
