#!/usr/bin/env python3
import argparse
import plistlib
import shutil
import subprocess
from pathlib import Path


LABEL = "ai.openclaw.opc-sentinel.daemon"
HOME = Path.home()
OPENCLAW_HOME = HOME / ".openclaw"
PLIST_PATH = Path("/Library/LaunchDaemons") / f"{LABEL}.plist"
SCRIPT_PATH = OPENCLAW_HOME / "workspace" / "skills" / "task-orchestrator" / "scripts" / "opc_sentinel.py"
LOG_DIR = Path("/tmp/openclaw")


def build_program_arguments(args: argparse.Namespace, python_path: str) -> list[str]:
    program_arguments = [
        python_path,
        str(SCRIPT_PATH),
        "--heartbeat-seconds",
        str(args.heartbeat_seconds),
        "--stuck-seconds",
        str(args.stuck_seconds),
        "--max-backups",
        str(args.max_backups),
        "--max-task-retries",
        str(args.max_task_retries),
    ]
    if args.kill_stuck_pids:
        program_arguments.append("--kill-stuck-pids")
    if args.allow_retry:
        program_arguments.append("--allow-retry")
    return program_arguments


def build_plist(args: argparse.Namespace, python_path: str) -> dict:
    return {
        "Label": LABEL,
        "RunAtLoad": True,
        "StartInterval": args.interval_minutes * 60,
        "WorkingDirectory": str(OPENCLAW_HOME),
        "ProgramArguments": build_program_arguments(args, python_path),
        "StandardOutPath": str(LOG_DIR / "opc-sentinel-daemon.log"),
        "StandardErrorPath": str(LOG_DIR / "opc-sentinel-daemon.err.log"),
        "EnvironmentVariables": {
            "HOME": str(HOME),
            "PATH": f"{Path(python_path).parent}:{Path(args.openclaw_bin).parent}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "OPC_SENTINEL_LABEL": LABEL,
            "OPENCLAW_BIN": args.openclaw_bin,
        },
        "ProcessType": "Background",
        "AbandonProcessGroup": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Install OPC Sentinel as a system LaunchDaemon.")
    parser.add_argument("--interval-minutes", type=int, choices=[1, 10, 30, 60], default=10)
    parser.add_argument("--heartbeat-seconds", type=int, default=90)
    parser.add_argument("--stuck-seconds", type=int, default=300)
    parser.add_argument("--max-backups", type=int, default=20)
    parser.add_argument("--max-task-retries", type=int, default=1)
    parser.add_argument("--kill-stuck-pids", action="store_true")
    parser.add_argument("--allow-retry", action="store_true")
    parser.add_argument("--openclaw-bin", default=shutil.which("openclaw") or "/usr/local/bin/openclaw")
    parser.add_argument("--write-only", action="store_true")
    args = parser.parse_args()

    python_path = shutil.which("python3") or "/usr/bin/python3"
    if not SCRIPT_PATH.exists():
        raise SystemExit(f"missing OPC Sentinel script: {SCRIPT_PATH}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    plist = build_plist(args, python_path)
    with PLIST_PATH.open("wb") as fh:
        plistlib.dump(plist, fh, sort_keys=False)

    # Best-effort permissions.
    try:
        LOG_DIR.chmod(0o755)
        for path in [LOG_DIR / "opc-sentinel-daemon.log", LOG_DIR / "opc-sentinel-daemon.err.log"]:
            path.touch(exist_ok=True)
            path.chmod(0o644)
        subprocess.run(["chown", "root:wheel", str(PLIST_PATH)], check=False)
        subprocess.run(["chmod", "644", str(PLIST_PATH)], check=False)
    except Exception:
        pass

    if not args.write_only:
        subprocess.run(["launchctl", "bootout", "system", str(PLIST_PATH)], check=False)
        subprocess.run(["launchctl", "bootstrap", "system", str(PLIST_PATH)], check=True)
        subprocess.run(["launchctl", "enable", f"system/{LABEL}"], check=False)
        subprocess.run(["launchctl", "kickstart", "-k", f"system/{LABEL}"], check=False)

    print(str(PLIST_PATH))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
