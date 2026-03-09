# OPC Sentinel Task Supervisor

This set of scripts packages the OPC Sentinel responsibilities into a reusable task-supervision plugin that sits beside `openclaw main`.

## Purpose
- Observe `~/.openclaw/orchestrator/tasks/TASK-*` runs and detect long-running or stalled executions.
- Emit `heartbeat_sent` / `blocked` events, queue follow-ups, and ensure tracked run metadata is kept aligned with the orchestrator state.  
- Leave gateway/channel recovery to upstream OpenClaw; OPC `opc_sentinel.py` now only makes observation-based recommendations.

## Installation
1. Ensure Python 3 is available in your PATH.
2. Use the LaunchAgent installer for user-level supervision:
   ```bash
   python3 skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py --interval-minutes 1
   ```
   The installer writes a LaunchAgent that runs `opc_sentinel.py` every minute with `--heartbeat-seconds 90`, `--stuck-seconds 300`, `--max-backups 20`, and `--max-task-retries 1` by default.
3. If you need a system-level daemon, the companion installer is `skills/task-orchestrator/scripts/install_opc_sentinel_daemon.py`, but the user-level LaunchAgent is sufficient for most setups.

## Runtime behavior
- `opc_sentinel.py` monitors each tracked task's `status.json`, writes structured `events.jsonl` entries, and queues follow-ups under `~/.openclaw/sentinel/task-followups/`.
- Sentinel only updates task status when it sees true heartbeat or blocked signals, and `skills/task-orchestrator/scripts/run_tracked_command.py` now merges on-disk state before writing so heartbeat timestamps survive.
- Gateway observations remain read-only; recover/restart logic is owned by upstream `openclaw gateway` health checks.

## Follow-up consumption
- Follow-ups are stored per task as `.json` files. Operator scripts such as `skills/task-orchestrator/scripts/list_task_followups.py`, `claim_next_followup.py`, and `update_task_followup.py` read/update this queue; orchestrator runtimes should consume them via `skills/task-orchestrator/scripts/orchestrator_runtime.py` or similar controllers.

## Validation notes
- Refer to `docs/2026-03-09-progress-summary.md` for the verified heartbeat/block tests and to `knowledge/2026-03-09-opc-productivity-requirements.md` for the current architecture boundary.

## Supporting scripts
- `skills/task-orchestrator/scripts/run_tracked_command.py` — the runner merges the latest `status.json` from disk before writing, so sentinel-written fields persist.
- `skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py` / `install_opc_sentinel_daemon.py` — produce the LaunchAgent/LaunchDaemon plists without gateway recovery flags.
- `skills/task-orchestrator/scripts/opc_sentinel.py` — main loop that emits heartbeat/follow-up events and exposes flags such as `--allow-retry`, `--skip-backup`, `--kill-stuck-pids`, and `--skip-gateway` to tune follow-up behavior.

## Next steps
1. Ship `public/opc-sentinel-plugin` branch as a plugin release for others to install.
2. Keep task-level follow-ups and heartbeat monitoring as the only responsibilities; avoid duplicating upstream gateway watchdog logic.
