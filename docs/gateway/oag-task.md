# OAG Task Board

> Owner: Henry
> Updated: 2026-03-17
> Branch: `codex/argus-private-recovery`
> Status: 204 tests passing, deployed locally

---

## Done (30 tasks)

- [x] P0-1 ~ P0-5: Bug fixes + core tests (65 tests)
- [x] P1-7: Language detection ja/ko
- [x] P1-8: Note deduplication
- [x] P2-4: Atomic file lock
- [x] P2-6: Metrics collector (9 counters)
- [x] P2-11: Config consolidation (7 params)
- [x] P2-closeout: Wire config + metrics + health endpoint
- [x] P3-10: Schema versioning v1/v2
- [x] EV-1: Persistent memory
- [x] EV-2: Post-recovery analysis engine
- [x] EV-3: Incident collector
- [x] EV-4: Lifecycle wiring (shutdown + startup)
- [x] EV-5: Config write-back
- [x] EV-6: Auto-rollback guard
- [x] EV-7: Evolution user notification
- [x] EV-8: Agent diagnosis module
- [x] EV-9: Idle-window scheduler
- [x] INT-1: Evolution guard → maintenance timer
- [x] INT-2: Postmortem → start observation
- [x] INT-3: Postmortem → idle scheduler
- [x] INT-4: Delivery index → queue operations
- [x] TEST-1: Evolution integration test
- [x] DOC-1: OAG config documentation
- [x] Build fix: scheduleFollowupDrain import
- [x] Deploy: npm link to local openclaw

---

## Wave A — Integration Closeout (Medium)

- [ ] **INT-5** Event bus startup
  - File: `server.impl.ts`
  - Wire `startFileWatcher` on gateway start, `stopFileWatcher` on close
  - Test: watcher lifecycle

- [ ] **INT-6** Agent diagnosis trigger
  - File: `oag-postmortem.ts`
  - When postmortem finds patterns but no recommendations → call `requestDiagnosis`
  - Test: trigger condition

- [ ] **INT-7** Agent diagnosis dispatch
  - File: `oag-diagnosis-dispatch.ts` (new)
  - Use embedded runner to send diagnosis prompt, parse response, apply recommendations
  - Dep: understand embedded runner API
  - Test: mock agent → verify config change

---

## Wave B — Safety Hardening (Medium)

- [ ] **SAFE-2** Incident collector memory limit
  - File: `oag-incident-collector.ts`
  - Cap `activeIncidents` Map at 100, evict oldest
  - Test: overflow behavior

- [ ] **SAFE-3** Memory file backup
  - File: `oag-memory.ts`
  - Write `.bak` before save, load from `.bak` on corruption
  - Test: corruption recovery

- [ ] **SAFE-4** Evolution notification rate limit
  - File: `oag-postmortem.ts`
  - Max 3 evolution notifications per 24 hours
  - Test: rate exceeded → skip

- [ ] **SAFE-5** Concurrent postmortem lock
  - File: `oag-postmortem.ts`
  - File lock to prevent parallel postmortem runs
  - Test: second runner skips

---

## Wave C — Testing & Docs (Medium)

- [ ] **TEST-2** server.impl.ts integration points
  - Verify shutdown snapshot, startup postmortem, incident recording don't silently fail
  - Test: import + call path verification

- [ ] **TEST-3** `inferSessionReplyLanguage` main entry
  - File: `session-language.test.ts`
  - Mock transcript file → verify language detection chain
  - Test: transcript parsing + language detection

- [ ] **DOC-2** Sentinel schema v1/v2 spec
  - File: `docs/gateway/oag-sentinel-schema.md` (new)
  - Content: field list, types, examples for v1 and v2

- [ ] **DOC-3** Operator evolution guide
  - File: `docs/gateway/oag.md` (extend)
  - Content: view history, manual rollback, disable auto-evolution

---

## Wave D — Performance (Low)

- [ ] **PERF-1** Confirm loadConfig caching
  - Check if `loadConfig()` is cached in memory
  - If not: cache at OAG function entry points
  - Action: confirm or fix

- [ ] **PERF-2** Status command cache switch
  - Use `getCachedHealthSnapshot()` from event bus instead of file read
  - Dep: INT-5
  - Test: cache hit vs file fallback

---

## Wave E — Deep Optimization (Low / Research)

- [ ] **OPT-1** Evolution dashboard in status output
  - Add `OAG evolution:` line to `openclaw status`
  - Show: last applied, outcome, parameter change summary
  - Add `oagEvolution` to `/health` JSON

- [ ] **OPT-2** Per-channel evolution parameters
  - Each channel gets independent OAG config (thresholds, retry counts)
  - Pattern: `gateway.oag.channels.telegram.delivery.maxRetries`

- [ ] **OPT-3** Evolution A/B testing framework
  - Run two parameter sets in parallel, auto-select winner
  - Research: bandit algorithm for online learning

- [ ] **OPT-4** Delivery queue performance benchmark
  - Generate 1K/5K/10K mock deliveries
  - Compare index vs no-index recovery scan time
  - Output: benchmark report with speedup factor

- [ ] **OPT-5** Japanese + Korean OAG note translations
  - Add ja/ko translation map to `resolveLocalizedOagMessage`
  - 7 action types × 2 languages = 14 translations

- [ ] **OPT-6** OAG WebSocket real-time push
  - Event bus → gateway broadcast → control UI auto-refresh
  - Dep: INT-5

---

## Execution Plan

```
Wave A (3 tasks, parallel):  INT-5 + INT-6 + INT-7
Wave B (4 tasks, parallel):  SAFE-2 + SAFE-3 + SAFE-4 + SAFE-5
Wave C (4 tasks, parallel):  TEST-2 + TEST-3 + DOC-2 + DOC-3
Wave D (2 tasks):            PERF-1 → PERF-2
Wave E (6 tasks):            OPT-1 → OPT-2 ~ OPT-6
```

## Counts

| Priority  | Tasks  | Status                |
| --------- | ------ | --------------------- |
| Done      | 30     | ✅                    |
| Medium    | 11     | ⏳ Wave A+B+C         |
| Low       | 8      | ⏳ Wave D+E           |
| **Total** | **49** | 30 done, 19 remaining |
