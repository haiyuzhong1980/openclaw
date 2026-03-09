#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


TASK_ROOT = Path.home() / ".openclaw" / "orchestrator" / "tasks"


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def merge_status_with_latest(path: Path, current: dict) -> dict:
    latest = read_json(path)

    # Preserve Sentinel-owned heartbeat markers across runner pulses/completion writes.
    if latest.get("heartbeat_at"):
        current["heartbeat_at"] = latest["heartbeat_at"]

    # If Sentinel has already escalated the task to blocked, do not silently
    # revert it back to running from an older in-memory runner snapshot.
    if latest.get("state") == "blocked":
        current["state"] = "blocked"
        current["blocked"] = True

    return current


def append_event(task_dir: Path, status: dict, agent: str, event: str, message: str, extra: dict | None = None) -> None:
    payload = {
        "ts": now_iso(),
        "agent": agent,
        "event": event,
        "state": status.get("state"),
        "current_step": status.get("current_step"),
        "total_steps": status.get("total_steps"),
        "step_title": status.get("step_title"),
        "phase": status.get("phase"),
        "phase_owner": status.get("phase_owner"),
        "run_id": status.get("run_id"),
        "child_session_key": status.get("child_session_key"),
        "retry_count": status.get("retry_count"),
        "blocked": status.get("blocked"),
        "message": message,
    }
    if extra:
        payload.update(extra)
    with (task_dir / "events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a command while keeping task bus status updated.")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--command", required=True)
    parser.add_argument("--agent", default="coder")
    parser.add_argument("--cwd", default="")
    parser.add_argument("--pulse-seconds", type=int, default=2)
    parser.add_argument("--phase", default="Execute tracked command")
    parser.add_argument("--phase-owner", default="coder")
    parser.add_argument("--current-step", type=int, default=1)
    parser.add_argument("--total-steps", type=int, default=2)
    parser.add_argument("--step-title", default="Run tracked command")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    task_dir = TASK_ROOT / args.task_id
    status_path = task_dir / "status.json"
    if not status_path.exists():
        raise SystemExit(f"Task not found: {args.task_id}")

    status = read_json(status_path)
    start_ts = now_iso()
    status.update(
        {
            "state": "running",
            "phase": args.phase,
            "phase_owner": args.phase_owner,
            "current_step": args.current_step,
            "total_steps": args.total_steps,
            "step_title": args.step_title,
            "updated_at": start_ts,
            "last_update_at": start_ts,
            "blocked": False,
        }
    )

    popen_cwd = args.cwd or str(Path.home() / ".openclaw")
    proc = subprocess.Popen(
        args.command,
        shell=True,
        cwd=popen_cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    status["pid"] = proc.pid
    status["retry_command"] = args.command
    status = merge_status_with_latest(status_path, status)
    write_json(status_path, status)
    append_event(task_dir, status, args.agent, "tracked_run_started", f"Started tracked command: {args.command}", {"pid": proc.pid})

    while True:
        result = proc.poll()
        if result is not None:
            stdout, stderr = proc.communicate()
            end_ts = now_iso()
            status["updated_at"] = end_ts
            status["last_update_at"] = end_ts
            status["blocked"] = result != 0
            if result == 0:
                status["state"] = "completed"
                status["current_step"] = args.total_steps
                status["step_title"] = "Tracked command completed"
                status = merge_status_with_latest(status_path, status)
                write_json(status_path, status)
                append_event(
                    task_dir,
                    status,
                    args.agent,
                    "tracked_run_completed",
                    "Tracked command completed successfully.",
                    {"exit_code": result, "stdout": stdout.strip(), "stderr": stderr.strip()},
                )
                result_path = task_dir / "result.md"
                result_path.write_text(
                    "# Result\n\n"
                    "## Completed\n\n"
                    f"- Command: `{args.command}`\n"
                    f"- Exit code: {result}\n\n"
                    "## Stdout\n\n"
                    "```\n"
                    f"{stdout.strip()}\n"
                    "```\n\n"
                    "## Stderr\n\n"
                    "```\n"
                    f"{stderr.strip()}\n"
                    "```\n",
                    encoding="utf-8",
                )
                return 0

            status["state"] = "failed"
            status = merge_status_with_latest(status_path, status)
            write_json(status_path, status)
            append_event(
                task_dir,
                status,
                args.agent,
                "tracked_run_failed",
                "Tracked command failed.",
                {"exit_code": result, "stdout": stdout.strip(), "stderr": stderr.strip()},
            )
            return result

        pulse_ts = now_iso()
        status["updated_at"] = pulse_ts
        status["last_update_at"] = pulse_ts
        status = merge_status_with_latest(status_path, status)
        write_json(status_path, status)
        append_event(
            task_dir,
            status,
            args.agent,
            "tracked_run_pulse",
            f"Tracked command still running (pid {proc.pid}).",
            {"pid": proc.pid},
        )
        time.sleep(args.pulse_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
