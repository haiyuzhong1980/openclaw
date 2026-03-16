# OAG Improvement Task List

> Generated: 2026-03-16
> Branch: `codex/argus-private-recovery`
> Owner: Henry (review/approve) + Codex agents (execute)

---

## P0 — Must-do before merge

### P0-1: Unit tests for `oag-channel-health.ts`

- **File:** `src/commands/oag-channel-health.test.ts` (new)
- **Scope:**
  - `readOagChannelHealthSummary`: valid JSON, missing fields, wrong types, mixed snake/camel naming, empty file, malformed JSON
  - `formatOagChannelHealthLine`: all 4 state branches (congested, escalation, backlog, clear)
  - `formatOagSessionWatchLine`: active, escalation, cleared, unavailable
  - `formatOagTaskWatchLine`: terminal stuck, normal follow-up, empty, clear
- **Acceptance:** All tests pass, covers the undefined crash fix from review finding #1
- **Status:** [x] Done — 22 tests passed (Codex agent, verified by total run)

### P0-2: Unit tests for `oag-system-events.ts`

- **File:** `src/infra/oag-system-events.test.ts` (new)
- **Scope:**
  - `noteMatchesSession`: exact match, case-insensitive, `sessionKeys` vs `session_keys` dual naming, no targets, empty sessionKey
  - `consumePendingOagSystemNotes`: single note, multiple notes all returned, no match returns empty, consumed notes move to delivered, delivered list capped at MAX_DELIVERED_NOTES
  - `resolveLocalizedOagMessage`: zh-Hans returns fallback, en returns hardcoded, undefined defaults to en
  - `normalizeNoteMessage`: truncation at 96 chars, whitespace collapse, empty
  - Lock behavior: basic acquire/release (mock fs)
- **Acceptance:** All tests pass, covers review findings #2 #3 #5
- **Status:** [x] Done — 8 tests passed (Codex agent, verified by total run)

### P0-3: Unit tests for `session-language.ts`

- **File:** `src/infra/session-language.test.ts` (new)
- **Scope:**
  - `detectSessionReplyLanguageFromText`: pure Chinese -> zh-Hans, pure English -> en, mixed content thresholds, empty/whitespace -> undefined, short text -> undefined
  - Edge cases: URLs with Latin chars in Chinese text, numbers only, emoji only
- **Acceptance:** All tests pass
- **Status:** [x] Done — 5 tests passed (Codex agent, verified by total run)

### P0-4: Confirm sentinel schema for `taskWatch.counts`

- **File:** `src/commands/oag-channel-health.ts` (potential fix)
- **Scope:**
  - Read a real `~/.openclaw/sentinel/channel-health-state.json` snapshot
  - Check if task_watch section uses `counts`, `task_counts`, or `state_counts`
  - If mismatch found, add fallback reading (like session_keys/sessionKeys pattern)
- **Acceptance:** Field name confirmed or fallback added
- **Status:** [x] Done — Confirmed `counts` is correct (camelCase in production). `affected_targets` uses camelCase (`accountId`, `sessionKeys`). No code change needed.

### P0-5: Unit tests for `stale-poll` in `channel-health-policy.test.ts`

- **File:** `src/gateway/channel-health-policy.test.ts` (extend existing)
- **Scope:**
  - Telegram channel with stale `lastInboundAt` -> `stale-poll`
  - Telegram channel with fresh `lastInboundAt` -> `healthy`
  - Webhook mode with stale `lastInboundAt` -> `stale-poll`
  - Polling channel with no `lastInboundAt` -> `healthy` (no false positive)
  - Verify 2x threshold factor (60 min vs 30 min)
  - `resolveChannelRestartReason` returns `"stale-poll"` for stale-poll evaluation
- **Acceptance:** All new tests pass alongside existing 16 tests
- **Status:** [x] Done — 6 new tests, 22 total passed (Codex agent, verified by total run)

---

## P1 — Short-term improvements

### P1-7: Extend language detection (ja, ko)

- **Status:** [ ] Not started

### P1-8: OAG note deduplication

- **Status:** [ ] Not started

---

## P2 — Medium-term improvements

### P2-4: Replace file lock with proper-lockfile

- **Status:** [ ] Not started

### P2-6: Expose Prometheus-style health metrics

- **Status:** [ ] Not started

### P2-11: Consolidate OAG config into gateway.oag section

- **Status:** [ ] Not started

---

## P3 — Long-term architecture

### P3-5: Migrate delivery queue to SQLite

- **Status:** [ ] Not started

### P3-9: Event-driven OAG (replace file polling)

- **Status:** [ ] Not started

### P3-10: Sentinel schema versioning

- **Status:** [ ] Not started
