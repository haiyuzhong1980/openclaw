#!/usr/bin/env python3
import argparse
import json
import os
import shlex
import signal
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple


TASK_ROOT = Path.home() / ".openclaw" / "orchestrator" / "tasks"
CONFIG_PATH = Path.home() / ".openclaw" / "openclaw.json"
BACKUP_ROOT = Path.home() / ".openclaw" / "backups" / "openclaw-json"
GATEWAY_LABEL = "ai.openclaw.gateway"
GATEWAY_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{GATEWAY_LABEL}.plist"
SENTINEL_STATE_ROOT = Path.home() / ".openclaw" / "sentinel"
GATEWAY_STATE_PATH = SENTINEL_STATE_ROOT / "gateway-state.json"
TASK_FOLLOWUP_ROOT = SENTINEL_STATE_ROOT / "task-followups"


def now_local() -> datetime:
    return datetime.now().astimezone()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_event(task_dir: Path, agent: str, event: str, state: str, message: str, extra: Optional[dict] = None) -> None:
    status = read_json(task_dir / "status.json")
    payload = {
        "ts": now_local().isoformat(),
        "agent": agent,
        "event": event,
        "state": state,
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
    with (task_dir / "events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def iso_to_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def ensure_backup(max_backups: int) -> Optional[Path]:
    if not CONFIG_PATH.exists():
        return None
    BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    stamp = now_local().strftime("%Y%m%d-%H%M%S")
    backup_path = BACKUP_ROOT / f"openclaw-{stamp}.json"
    shutil.copy2(CONFIG_PATH, backup_path)
    backups = sorted(BACKUP_ROOT.glob("openclaw-*.json"))
    for old in backups[:-max_backups]:
        old.unlink(missing_ok=True)
    return backup_path


def gateway_status() -> Tuple[bool, str]:
    try:
        proc = subprocess.run(
            ["openclaw", "gateway", "status"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"gateway status check failed to execute: {exc}"

    output = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
    output = output.strip()
    lowered = output.lower()
    system_failure_markers = [
        "gateway port",
        "gateway closed",
        "runtime: stopped",
        "runtime: not running",
        "config (cli): ~/.openclaw/openclaw.json (missing)",
        "config (service): ~/.openclaw/openclaw.json (missing)",
    ]
    rpc_ok = "rpc probe: ok" in lowered
    listening_ok = "listening:" in lowered
    healthy = (
        (proc.returncode == 0 or (rpc_ok and listening_ok))
        and not any(marker in lowered for marker in system_failure_markers)
        and classify_gateway_failure(output) == "warning_only"
    ) or (rpc_ok and listening_ok and classify_gateway_failure(output) == "warning_only")
    return healthy, output or f"exit={proc.returncode}"


def read_gateway_state() -> dict:
    if not GATEWAY_STATE_PATH.exists():
        return {"consecutive_system_failures": 0, "last_failure_kind": "", "updated_at": ""}
    try:
        return read_json(GATEWAY_STATE_PATH)
    except Exception:
        return {"consecutive_system_failures": 0, "last_failure_kind": "", "updated_at": ""}


def write_gateway_state(data: dict) -> None:
    SENTINEL_STATE_ROOT.mkdir(parents=True, exist_ok=True)
    write_json(GATEWAY_STATE_PATH, data)


def task_followup_path(task_id: str) -> Path:
    return TASK_FOLLOWUP_ROOT / f"{task_id}.json"


def read_task_followup(task_id: str) -> Optional[dict]:
    path = task_followup_path(task_id)
    if not path.exists():
        return None
    try:
        return read_json(path)
    except Exception:
        return None


def write_task_followup(task_id: str, payload: dict) -> None:
    TASK_FOLLOWUP_ROOT.mkdir(parents=True, exist_ok=True)
    write_json(task_followup_path(task_id), payload)


def queue_task_followup(
    status: dict,
    *,
    followup_type: str,
    message: str,
    source_event: str,
    priority: str = "normal",
    extra: Optional[dict] = None,
) -> dict:
    task_id = status["task_id"]
    existing = read_task_followup(task_id)
    if existing and existing.get("status") == "pending" and existing.get("followup_type") == followup_type:
        existing["updated_at"] = now_local().isoformat()
        existing["message"] = message
        if extra:
            existing.update(extra)
        write_task_followup(task_id, existing)
        return existing

    payload = {
        "task_id": task_id,
        "status": "pending",
        "followup_type": followup_type,
        "priority": priority,
        "created_at": now_local().isoformat(),
        "updated_at": now_local().isoformat(),
        "source": "opc-sentinel",
        "source_event": source_event,
        "phase": status.get("phase"),
        "phase_owner": status.get("phase_owner"),
        "current_step": status.get("current_step"),
        "total_steps": status.get("total_steps"),
        "message": message,
    }
    if extra:
        payload.update(extra)
    write_task_followup(task_id, payload)
    return payload


def update_status_for_sentinel(
    task_dir: Path,
    status: dict,
    *,
    event: str,
    message: str,
    state: Optional[str] = None,
    heartbeat: bool = False,
    blocked: Optional[bool] = None,
) -> None:
    now = now_local().isoformat()
    status["updated_at"] = now
    if heartbeat:
        status["heartbeat_at"] = now
    if state is not None:
        status["state"] = state
    if blocked is not None:
        status["blocked"] = blocked
    write_json(task_dir / "status.json", status)
    append_event(task_dir, "opc-sentinel", event, status["state"], message)


def kill_pid(pid: int) -> Tuple[bool, str]:
    try:
        os.kill(pid, signal.SIGTERM)
        return True, f"Sent SIGTERM to pid {pid}"
    except ProcessLookupError:
        return False, f"pid {pid} not found"
    except PermissionError:
        return False, f"permission denied for pid {pid}"
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"failed to kill pid {pid}: {exc}"


def restart_task(status: dict) -> Tuple[bool, str, int]:
    retry_command = (status.get("retry_command") or "").strip()
    if not retry_command:
        return False, "retry_command is empty", 0
    try:
        proc = subprocess.Popen(
            shlex.split(retry_command),
            cwd=str(TASK_ROOT.parent.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"failed to restart: {exc}", 0
    return True, f"restarted with pid {proc.pid}", proc.pid


def has_only_ignorable_plugin_config_issues(detail: str) -> bool:
    lowered = detail.lower()
    plugin_markers = [
        "plugins.allow: plugin not found",
        "plugins.entries.smart-message-handler: plugin not found",
        "suspicious ownership",
        "stale config entry ignored",
        "blocked plugin candidate",
    ]
    invalid_markers = ["config invalid", "invalid config", "problem:"]
    has_plugin_noise = any(marker in lowered for marker in plugin_markers)
    has_invalid = any(marker in lowered for marker in invalid_markers)
    has_gateway_hard_failure = any(
        marker in lowered
        for marker in ["gateway closed", "gateway port", "runtime: stopped", "runtime: not running", "rpc probe: failed"]
    )
    return has_plugin_noise and has_invalid and not has_gateway_hard_failure


def classify_gateway_failure(detail: str) -> str:
    lowered = detail.lower()
    if has_only_ignorable_plugin_config_issues(detail):
        return "warning_only"
    if "gateway port" in lowered or "runtime: stopped" in lowered or "runtime: not running" in lowered:
        return "gateway_down"
    if "gateway closed" in lowered or "rpc probe: failed" in lowered:
        return "gateway_stuck"
    if "config invalid" in lowered or "invalid config" in lowered or "problem:" in lowered:
        return "config_invalid"
    return "warning_only"

def inspect_task(
    task_dir: Path,
    heartbeat_seconds: int,
    stuck_seconds: int,
    *,
    kill_stuck_pids: bool,
    allow_retry: bool,
    max_task_retries: int,
) -> List[str]:
    status_path = task_dir / "status.json"
    if not status_path.exists():
        return []
    status = read_json(status_path)
    if status.get("state") != "running":
        return []

    messages: List[str] = []
    last_update = iso_to_dt(status.get("last_update_at") or status.get("updated_at"))
    last_heartbeat = iso_to_dt(status.get("heartbeat_at"))
    now = now_local()
    if last_update is None:
        update_status_for_sentinel(
            task_dir,
            status,
            event="sentinel_missing_timestamp",
            message="Task had no valid last_update_at; refreshed status timestamp.",
        )
        messages.append(f"{task_dir.name}: repaired missing timestamp")
        return messages

    age = (now - last_update).total_seconds()
    task_stuck_after = int(status.get("stuck_after_seconds") or stuck_seconds)

    if age >= task_stuck_after:
        pid = int(status.get("pid") or 0)
        if kill_stuck_pids and pid > 0:
            killed, detail = kill_pid(pid)
            append_event(
                task_dir,
                "opc-sentinel",
                "run_kill_attempted",
                status.get("state", "running"),
                detail,
                {"pid": pid, "kill_success": killed},
            )
            messages.append(f"{task_dir.name}: {detail}")

        retries = int(status.get("retry_count") or 0)
        if allow_retry and retries < max_task_retries and (status.get("retry_command") or "").strip():
            restarted, detail, new_pid = restart_task(status)
            if restarted:
                status["retry_count"] = retries + 1
                status["pid"] = new_pid
                status["state"] = "running"
                status["blocked"] = False
                status["updated_at"] = now.isoformat()
                status["last_update_at"] = now.isoformat()
                status["heartbeat_at"] = ""
                write_json(task_dir / "status.json", status)
                append_event(
                    task_dir,
                    "opc-sentinel",
                    "run_restarted",
                    "running",
                    detail,
                    {"pid": new_pid, "retry_count": status["retry_count"]},
                )
                queue_task_followup(
                    status,
                    followup_type="retry_review",
                    message=f"Task was restarted by OPC Sentinel: {detail}",
                    source_event="run_restarted",
                    priority="high",
                    extra={"pid": new_pid, "retry_count": status["retry_count"]},
                )
                messages.append(f"{task_dir.name}: {detail}")
                return messages
            append_event(
                task_dir,
                "opc-sentinel",
                "run_restart_failed",
                status.get("state", "running"),
                detail,
                {"retry_count": retries},
            )
            messages.append(f"{task_dir.name}: {detail}")

        update_status_for_sentinel(
            task_dir,
            status,
            event="run_stuck",
            state="blocked",
            blocked=True,
            message=f"Task exceeded stuck threshold ({int(age)}s >= {task_stuck_after}s).",
        )
        queue_task_followup(
            status,
            followup_type="blocked_review",
            message=f"Task blocked after exceeding stuck threshold ({int(age)}s >= {task_stuck_after}s).",
            source_event="run_stuck",
            priority="high",
            extra={"age_seconds": int(age), "stuck_after_seconds": task_stuck_after},
        )
        messages.append(f"{task_dir.name}: marked blocked as stuck")
        return messages

    heartbeat_due = age >= heartbeat_seconds and (
        last_heartbeat is None or (now - last_heartbeat).total_seconds() >= heartbeat_seconds
    )
    if heartbeat_due:
        update_status_for_sentinel(
            task_dir,
            status,
            event="heartbeat_sent",
            heartbeat=True,
            message=(
                f"Silent sentinel heartbeat: phase={status.get('phase') or '?'} "
                f"owner={status.get('phase_owner') or status.get('owner') or '?'} "
                f"age={int(age)}s"
            ),
        )
        queue_task_followup(
            status,
            followup_type="heartbeat_review",
            message=(
                f"Task still running without visible completion. "
                f"phase={status.get('phase') or '?'} owner={status.get('phase_owner') or status.get('owner') or '?'} age={int(age)}s"
            ),
            source_event="heartbeat_sent",
            priority="normal",
            extra={"age_seconds": int(age)},
        )
        messages.append(f"{task_dir.name}: heartbeat recorded")

    return messages


def main() -> int:
    parser = argparse.ArgumentParser(description="OPC Sentinel V2 for tracked OpenClaw tasks.")
    parser.add_argument("--heartbeat-seconds", type=int, default=90)
    parser.add_argument("--stuck-seconds", type=int, default=300)
    parser.add_argument("--max-backups", type=int, default=20)
    parser.add_argument("--max-task-retries", type=int, default=1)
    parser.add_argument("--kill-stuck-pids", action="store_true")
    parser.add_argument("--allow-retry", action="store_true")
    parser.add_argument("--skip-backup", action="store_true")
    parser.add_argument("--skip-gateway", action="store_true")
    args = parser.parse_args()

    results: dict[str, object] = {
        "ts": now_local().isoformat(),
        "component": "opc-sentinel",
        "task_events": [],
        "config_backup": None,
        "gateway": None,
    }

    if not args.skip_backup:
        backup_path = ensure_backup(args.max_backups)
        if backup_path is not None:
            results["config_backup"] = str(backup_path)

    task_events: List[str] = []
    if TASK_ROOT.exists():
        for task_dir in sorted(p for p in TASK_ROOT.iterdir() if p.is_dir() and p.name.startswith("TASK-")):
            task_events.extend(
                inspect_task(
                    task_dir,
                    args.heartbeat_seconds,
                    args.stuck_seconds,
                    kill_stuck_pids=args.kill_stuck_pids,
                    allow_retry=args.allow_retry,
                    max_task_retries=args.max_task_retries,
                )
            )
    results["task_events"] = task_events

    if not args.skip_gateway:
        healthy, output = gateway_status()
        failure_kind = classify_gateway_failure(output)
        results["gateway"] = {
            "healthy": healthy,
            "detail": output,
            "failure_kind": failure_kind,
            "mode": "observe-only",
        }
        gateway_state = read_gateway_state()
        gateway_state["updated_at"] = now_local().isoformat()
        gateway_state["last_failure_kind"] = "" if healthy else failure_kind
        gateway_state["consecutive_system_failures"] = 0
        gateway_state["observation_mode"] = "upstream-runtime-owned"
        write_gateway_state(gateway_state)
        results["gateway_state"] = gateway_state

    json.dump(results, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
