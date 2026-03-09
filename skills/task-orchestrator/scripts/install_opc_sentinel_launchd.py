#!/usr/bin/env python3
import argparse
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path


LABEL = "ai.openclaw.opc-sentinel"
HOME = Path.home()
OPENCLAW_HOME = HOME / ".openclaw"
LAUNCH_AGENTS = HOME / "Library" / "LaunchAgents"
PLIST_PATH = LAUNCH_AGENTS / f"{LABEL}.plist"
SCRIPT_PATH = OPENCLAW_HOME / "workspace" / "skills" / "task-orchestrator" / "scripts" / "opc_sentinel.py"
LOG_DIR = OPENCLAW_HOME / "logs"


def build_plist(
    python_path: str,
    interval: int,
    heartbeat: int,
    stuck: int,
    max_backups: int,
    max_task_retries: int,
    kill_stuck_pids: bool,
    allow_retry: bool,
) -> dict:
    program_arguments = [
        python_path,
        str(SCRIPT_PATH),
        "--heartbeat-seconds",
        str(heartbeat),
        "--stuck-seconds",
        str(stuck),
        "--max-backups",
        str(max_backups),
        "--max-task-retries",
        str(max_task_retries),
    ]
    if kill_stuck_pids:
        program_arguments.append("--kill-stuck-pids")
    if allow_retry:
        program_arguments.append("--allow-retry")

    return {
        "Label": LABEL,
        "RunAtLoad": True,
        "StartInterval": interval,
        "WorkingDirectory": str(OPENCLAW_HOME),
        "ProgramArguments": program_arguments,
        "StandardOutPath": str(LOG_DIR / "opc-sentinel.log"),
        "StandardErrorPath": str(LOG_DIR / "opc-sentinel.err.log"),
        "EnvironmentVariables": {
            "HOME": str(HOME),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"),
            "OPC_SENTINEL_LABEL": LABEL,
        },
        "ProcessType": "Background",
        "AbandonProcessGroup": True,
    }


def maybe_bootstrap(plist_path: Path) -> None:
    domain_target = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain_target, str(plist_path)], check=False)
    subprocess.run(["launchctl", "bootstrap", domain_target, str(plist_path)], check=True)
    subprocess.run(["launchctl", "enable", f"{domain_target}/{LABEL}"], check=False)
    subprocess.run(["launchctl", "kickstart", "-k", f"{domain_target}/{LABEL}"], check=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Install OPC Sentinel as a launchd LaunchAgent.")
    parser.add_argument("--interval-minutes", type=int, choices=[1, 10, 30, 60], default=1)
    parser.add_argument("--heartbeat-seconds", type=int, default=90)
    parser.add_argument("--stuck-seconds", type=int, default=300)
    parser.add_argument("--max-backups", type=int, default=20)
    parser.add_argument("--max-task-retries", type=int, default=1)
    parser.add_argument("--kill-stuck-pids", action="store_true")
    parser.add_argument("--allow-retry", action="store_true")
    parser.add_argument("--write-only", action="store_true")
    args = parser.parse_args()

    python_path = shutil.which("python3")
    if not python_path:
        raise SystemExit("python3 not found in PATH")
    if not SCRIPT_PATH.exists():
        raise SystemExit(f"missing OPC Sentinel script: {SCRIPT_PATH}")

    LAUNCH_AGENTS.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    plist = build_plist(
        python_path=python_path,
        interval=args.interval_minutes * 60,
        heartbeat=args.heartbeat_seconds,
        stuck=args.stuck_seconds,
        max_backups=args.max_backups,
        max_task_retries=args.max_task_retries,
        kill_stuck_pids=args.kill_stuck_pids,
        allow_retry=args.allow_retry,
    )
    with PLIST_PATH.open("wb") as fh:
        plistlib.dump(plist, fh, sort_keys=False)

    if not args.write_only:
        maybe_bootstrap(PLIST_PATH)

    print(str(PLIST_PATH))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
