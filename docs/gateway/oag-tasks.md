# OAG Improvement Task List

> Updated: 2026-03-17
> Branch: `codex/argus-private-recovery`
> Owner: Henry (review/approve) + Claude/Codex agents (execute)

---

## Completed Milestones

### P0 — Code review fixes + core tests — ✅ CLOSED (65 tests)

- [x] P0-1: Unit tests for `oag-channel-health.ts` (22 tests)
- [x] P0-2: Unit tests for `oag-system-events.ts` (11 tests + 3 lock tests)
- [x] P0-3: Unit tests for `session-language.ts` (5 tests)
- [x] P0-4: Confirm sentinel schema (verified: `counts` correct, camelCase in production)
- [x] P0-5: stale-poll tests for `channel-health-policy.ts` (6 tests)

### P1 — Language detection + note dedup — ✅ CLOSED (71 tests)

- [x] P1-7: Extend language detection (ja, ko) — 3 new tests
- [x] P1-8: OAG note deduplication — 3 new tests

### P2 — Atomic lock + metrics + config — ✅ CLOSED (148 tests)

- [x] P2-4: Atomic file lock (`fs.open("wx")` + PID stale recovery)
- [x] P2-6: OAG metrics collector (9 counters, /health endpoint)
- [x] P2-11: OAG config consolidation (7 resolvers, types.oag.ts)
- [x] P2-closeout: Wire config into source files + metrics callsites + health endpoint

### P3-10 — Schema versioning — ✅ CLOSED (165 tests)

- [x] P3-10: Sentinel schema versioning (v1 dual-naming / v2 strict snake_case)

### Evolution Foundation — ✅ CLOSED (165 tests)

- [x] EV-1: Persistent memory (`oag-memory.ts`) — 6 tests
- [x] EV-2: Post-recovery analysis engine (`oag-postmortem.ts`) — 4 tests
- [x] EV-3: Incident collector (`oag-incident-collector.ts`) — 4 tests
- [x] EV-4: Lifecycle wiring (shutdown snapshot + startup postmortem + incident recording)

---

## Next: Phase 5 — Evolution Completion + Architecture

### EV-5: Config write-back for evolution recommendations

- **Files:** `src/infra/oag-postmortem.ts` (modify), `src/config/config.ts` (use writeConfigFile)
- **Scope:**
  - After `runPostRecoveryAnalysis` produces low-risk `applied` recommendations, actually write the adjusted values to `~/.openclaw/config.json` via `writeConfigFile`
  - Merge changes into existing `gateway.oag` section without overwriting unrelated config
  - Trigger config hot-reload so changes take effect without restart
  - Add a `dryRun` option (default: false in production, true in tests)
  - Log all applied changes with before/after values
- **Tests:**
  - Config file written with correct merged values
  - Existing non-OAG config preserved
  - dryRun mode does not write
  - Invalid/missing config file handled gracefully
- **Acceptance:** Evolution recommendations actually persist across restarts
- **Status:** [ ] Not started

### EV-6: Auto-rollback on regression

- **Files:** `src/infra/oag-evolution-guard.ts` (new), `src/infra/oag-postmortem.ts` (modify)
- **Scope:**
  - After applying an evolution, start a 1-hour observation window
  - Track key regression signals: crash count, recovery failure rate, stale detection rate
  - If regression detected (metrics worse than pre-evolution baseline), automatically:
    1. Revert config to pre-evolution values via writeConfigFile
    2. Record `outcome: "reverted"` in evolution record
    3. Log the rollback with reason
  - If observation window passes without regression, record `outcome: "effective"`
  - Persist observation state in oag-memory.json (survives restarts mid-observation)
- **Tests:**
  - Regression detected → config reverted + evolution marked "reverted"
  - No regression → evolution marked "effective"
  - Observation survives gateway restart
  - Multiple evolutions queued during observation are blocked (cooldown)
- **Acceptance:** Bad parameter changes are automatically undone within 1 hour
- **Status:** [ ] Not started

### EV-7: Evolution notification as OAG user note

- **Files:** `src/infra/oag-postmortem.ts` (modify), `src/infra/oag-system-events.ts` (use existing pending_user_notes)
- **Scope:**
  - When postmortem produces a `userNotification`, inject it as a pending OAG note into `channel-health-state.json`
  - Target: the main session (or all active sessions if no main session)
  - Use action `"oag_evolution"` so it can be localized later
  - Note text example: "OAG: I analyzed 4 recent incidents and adjusted the recovery budget to reduce channel disruption."
  - Only inject once per evolution (use evolution record ID as dedup key)
- **Tests:**
  - Notification injected into pending_user_notes after evolution
  - Dedup prevents duplicate notifications for same evolution
  - No notification when no changes applied
- **Acceptance:** Users see a one-shot notification after OAG self-improves
- **Status:** [ ] Not started

### EV-8: Agent-assisted diagnosis (Layer 4)

- **Files:** `src/infra/oag-diagnosis.ts` (new), `src/infra/oag-diagnosis.test.ts` (new)
- **Scope:**
  - Trigger conditions: recurring pattern that heuristic postmortem cannot resolve (≥3 occurrences, postmortem ran but produced no effective recommendation)
  - Compose structured diagnosis prompt with:
    - Recent lifecycle history (last 5 from oag-memory)
    - Current metrics snapshot
    - Current OAG config
    - Recent error log tail (last 50 lines from gateway log)
    - Previous evolution records
  - Dispatch diagnosis via internal agent session:
    - Use dedicated agent ID `oag` or session prefix `oag:diagnosis:`
    - Use haiku model (fast, cheap, sufficient for structured analysis)
    - Set `skipOutboundDelivery: true` — user sees nothing
    - Set `skipSessionStore: true` — not visible in session list
  - Parse structured JSON response from agent
  - Store diagnosis in oag-memory.json
  - Low-risk config_change recommendations → auto-apply (same path as EV-5)
  - Medium/high risk → log only, notify operator via OAG note
  - Rate limit: max 1 diagnosis per 4 hours per pattern type
- **Tests:**
  - Prompt includes all required context sections
  - JSON response parsed correctly
  - Low-risk recommendation applied
  - High-risk recommendation logged but not applied
  - Rate limit enforced
  - Agent session is invisible (no channel delivery, no session store entry)
- **Acceptance:** Agent analyzes root causes silently, user only sees "OAG improved X"
- **Status:** [ ] Not started

### EV-9: Idle-window scheduling for evolution tasks

- **Files:** `src/infra/oag-scheduler.ts` (new)
- **Scope:**
  - Evolution tasks (postmortem, diagnosis) should only run when gateway is idle
  - Check: `getTotalQueueSize() === 0 && getTotalPendingReplies() === 0 && getActiveEmbeddedRunCount() === 0`
  - If not idle, defer with exponential backoff (5s, 10s, 20s, max 60s)
  - Max wait before giving up: 5 minutes (run anyway if never idle)
  - Wire into postmortem startup path (replace current immediate `void` dispatch)
- **Tests:**
  - Runs immediately when idle
  - Defers when queue has items
  - Gives up and runs after max wait
- **Acceptance:** Evolution never delays user message processing
- **Status:** [ ] Not started

---

### P3-5: Migrate delivery queue to SQLite

- **Files:** `src/infra/outbound/delivery-queue.ts` (rewrite), `src/infra/outbound/delivery-queue.test.ts` (new)
- **Scope:**
  - Replace filesystem directory queue with SQLite database (better-sqlite3)
  - Schema: `CREATE TABLE deliveries (id TEXT PRIMARY KEY, channel TEXT, account_id TEXT, to_addr TEXT, payload JSON, retry_count INT, enqueued_at INT, last_attempt_at INT, last_error TEXT, lane_priority TEXT, status TEXT DEFAULT 'pending')`
  - Index: `CREATE INDEX idx_channel_account ON deliveries (channel, account_id, status)`
  - Replace `loadPendingDeliveries` full-dir scan with `SELECT WHERE status='pending' AND channel=? AND account_id=?`
  - Replace atomic rename two-phase with SQL transaction
  - Replace `moveToFailed` with `UPDATE status='failed'`
  - Migration: on first run, scan existing `.json` files and import into SQLite, then remove
  - Keep `enqueueDelivery` / `ackDelivery` / `failDelivery` API signatures unchanged
- **Tests:**
  - Enqueue + ack round-trip
  - Enqueue + fail + retry
  - Filter by channel:account
  - Migration from filesystem queue
  - Concurrent enqueue/ack safety
- **Acceptance:** All existing outbound.test.ts tests pass with new backend
- **Dependencies:** better-sqlite3 npm package (check if already in repo deps)
- **Status:** [ ] Not started

### P3-9: Event-driven OAG (replace file polling)

- **Files:** `src/infra/oag-event-bus.ts` (new), sentinel pipeline (external)
- **Scope:**
  - Define OAG event types: `channel_state_changed`, `session_watch_update`, `task_watch_update`, `user_note_pending`
  - Create in-process EventEmitter-based bus for gateway-internal events
  - For sentinel → OAG communication: use fs.watch on `channel-health-state.json` + debounce (50ms)
  - Replace pull-based `readOagChannelHealthSummary()` in status commands with cached snapshot updated by events
  - Replace pull-based `consumePendingOagSystemNotes()` with event-triggered consumption
  - Keep file-based path as fallback when event bus is unavailable
- **Tests:**
  - Event emission on file change
  - Debounce prevents rapid-fire processing
  - Cached snapshot consistency
  - Fallback to file read when bus unavailable
- **Acceptance:** Status commands respond from cache (sub-ms), notes delivered within 50ms of file write
- **Status:** [ ] Not started

---

## Task Dependencies

```
EV-5 (config write-back) ← required by EV-6, EV-8
EV-6 (auto-rollback) ← requires EV-5
EV-7 (user notification) ← independent, can run in parallel with EV-5/6
EV-8 (agent diagnosis) ← requires EV-5; optional dep on EV-9
EV-9 (idle scheduling) ← independent, can run in parallel

P3-5 (SQLite queue) ← independent of evolution work
P3-9 (event-driven) ← independent, but benefits from EV pipeline being stable
```

## Suggested Execution Order

```
Wave 1 (parallel):  EV-5 + EV-7 + EV-9
Wave 2 (parallel):  EV-6 + EV-8 (after EV-5 done)
Wave 3:             P3-5 (SQLite)
Wave 4:             P3-9 (event-driven)
```

## Priority Legend

| Priority | Meaning                  | Timeline |
| -------- | ------------------------ | -------- |
| EV-5/6/7 | Evolution must-have      | 1-2 days |
| EV-8/9   | Evolution nice-to-have   | 2-3 days |
| P3-5     | Performance optimization | 2 days   |
| P3-9     | Architecture upgrade     | 3-5 days |
