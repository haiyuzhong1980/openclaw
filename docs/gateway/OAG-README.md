# OAG Runtime — Operational Assurance Gateway

> **Branch:** `codex/argus-private-recovery`
> **Status:** Feature-complete, 204 tests passing
> **Stats:** 14 commits, 50 files, 6,187 lines added

---

## What is OAG? / OAG 是什么？

**OAG (Operational Assurance Gateway)** is the self-evolving runtime observability and recovery layer for the OpenClaw Gateway. It monitors channel delivery pressure, stalled sessions, and stuck task follow-ups, then automatically recovers, adapts its own parameters based on crash history, and notifies users — all without human intervention.

**OAG（运维保障网关）** 是 OpenClaw Gateway 的自进化运行时可观测性与恢复层。它监控频道投递压力、会话停滞和任务跟进卡死，然后自动恢复、根据崩溃历史自适应调整参数并通知用户——全程无需人工干预。

---

## Features / 功能特性

### 1. Operator-Facing Status / 运维状态展示

OAG summaries in three CLI commands / OAG 摘要集成到三个 CLI 命令：

- **`openclaw status`** — OAG channels / sessions / tasks overview
- **`openclaw health --json`** — live Gateway snapshot with OAG metrics
- **`openclaw doctor`** — diagnostic output with OAG summaries

```
OAG channels:  congested · 12 pending · 3 failures · OAG containing pressure on telegram
OAG sessions:  watching 2 sessions · stalled:1, blocked:1 · telegram
OAG tasks:     task follow-up · step 3/5 · 8m · escalation x2
```

### 2. Channel Recovery with Delivery Replay / 频道恢复与投递重放

When a channel reconnects, OAG automatically replays queued outbound deliveries for that channel:account. / 频道重连时，OAG 自动重放该频道:账户的排队消息。

- Scoped to recovered channel:account only / 仅限已恢复的频道:账户
- Concurrent recovery deduplicated / 并发恢复去重
- Rapid reconnect triggers follow-up recovery pass / 快速重连触发跟进恢复
- Crash-safe delivery queue with atomic rename / 崩溃安全投递队列（原子重命名）
- JSON index for fast filtered lookups / JSON 索引加速过滤查询

### 3. One-Shot Recovery Notes / 一次性恢复通知

OAG injects `OAG:` system notes into the next matching session reply. / OAG 向匹配的下次会话回复注入 `OAG:` 系统通知。

```
OAG: I restarted the message gateway to clear lingering channel backlog.
OAG: Channel backlog cleared and delivery resumed.
OAG: I analyzed 4 recent incidents and adjusted the recovery budget to reduce channel disruption.
```

- Targeted to specific sessions via `sessionKeys` / 通过 `sessionKeys` 精准定向
- Consumed exactly once / 精确一次消费
- Deduplicated by action within 60s window (configurable) / 同 action 60 秒内去重（可配置）
- Atomic file lock with PID-based stale recovery / 原子文件锁 + PID 过期回收

### 4. Language Detection / 语言检测

| Language  | Detection             | Notes                                                |
| --------- | --------------------- | ---------------------------------------------------- |
| `zh-Hans` | Han characters ≥ 2    | 简体中文                                             |
| `en`      | Latin ≥ 6, Han = 0    | English                                              |
| `ja`      | Hiragana/Katakana ≥ 2 | 日本語 — distinguished from Chinese by kana presence |
| `ko`      | Hangul ≥ 2            | 한국어                                               |

OAG notes and heartbeat prompts are localized to the detected language. / OAG 通知和心跳按检测到的语言本地化。

### 5. Channel Health Policy / 频道健康策略

| Reason         | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `healthy`      | Operating normally / 正常运行                                   |
| `busy`         | Active runs / 有活跃运行                                        |
| `disconnected` | WebSocket disconnected / 断开                                   |
| `stale-socket` | No events within 30 min threshold / 30 分钟无事件               |
| `stale-poll`   | Telegram/webhook: no inbound within 60 min / 轮询 60 分钟无入站 |
| `stuck`        | Busy but run activity stale / 忙碌但活动过期                    |

Auto-restart with exponential backoff (5s → 5min), max 10 attempts. / 指数退避自动重启，最多 10 次。

### 6. Structured Metrics / 结构化指标

9 counters exposed via `/health` endpoint: / 9 个计数器通过 `/health` 端点暴露：

| Counter                    | Callsite                                            |
| -------------------------- | --------------------------------------------------- |
| `channelRestarts`          | Health monitor triggered restart / 健康监控触发重启 |
| `deliveryRecoveries`       | Successful delivery recovery / 投递恢复成功         |
| `deliveryRecoveryFailures` | Failed delivery recovery / 投递恢复失败             |
| `staleSocketDetections`    | WebSocket stale detection / WebSocket 过期检测      |
| `stalePollDetections`      | Polling stale detection / 轮询过期检测              |
| `noteDeliveries`           | OAG notes delivered / 通知投递                      |
| `noteDeduplications`       | Duplicate notes suppressed / 通知去重抑制           |
| `lockAcquisitions`         | Lock acquired / 锁获取                              |
| `lockStalRecoveries`       | Stale lock recovered / 过期锁回收                   |

### 7. Configurable Parameters / 可配置参数

All OAG constants are tunable via `gateway.oag.*` config: / 所有 OAG 常量可通过配置调整：

| Parameter                   | Default | Description                                |
| --------------------------- | ------- | ------------------------------------------ |
| `delivery.maxRetries`       | 5       | Max delivery retry attempts / 最大投递重试 |
| `delivery.recoveryBudgetMs` | 60000   | Recovery time budget / 恢复时间预算        |
| `lock.timeoutMs`            | 2000    | Lock acquire timeout / 锁获取超时          |
| `lock.staleMs`              | 30000   | Stale lock threshold / 锁过期阈值          |
| `health.stalePollFactor`    | 2       | Poll stale multiplier / 轮询过期倍数       |
| `notes.dedupWindowMs`       | 60000   | Note dedup window (0=disable) / 去重窗口   |
| `notes.maxDeliveredHistory` | 20      | Audit trail cap / 审计上限                 |

Changes take effect at runtime without restart. / 修改后运行时即时生效，无需重启。

### 8. Schema Versioning / Schema 版本化

- **v1** (default): Dual snake_case/camelCase naming for backward compatibility / 双命名兼容
- **v2**: Strict snake_case only, detected via `schema_version: 2` field / 严格蛇形命名

---

## Self-Evolution System / 自进化系统

OAG learns from crashes and automatically improves its own parameters across gateway restarts.

OAG 从崩溃中学习，跨 gateway 重启自动改进自身参数。

### How it works / 工作原理

```
Gateway crashes / channels fail
    │
    ├── Incident collector records events in memory
    │
    ▼
Gateway shuts down
    │
    ├── Lifecycle snapshot → oag-memory.json
    │   (metrics + incidents + stop reason)
    │
    ▼
Gateway restarts
    │
    ├── Load crash history from oag-memory.json
    │
    ├── Wait for idle window (no user messages queued)
    │
    ├── Post-recovery analysis scans crash patterns
    │   ├── Recurring crash loop → increase recovery budget
    │   ├── Delivery failures → increase retry limit
    │   ├── Stale false positives → relax threshold
    │   └── Lock contention → increase stale timeout
    │
    ├── Low-risk changes → auto-apply to config
    │
    ├── Start 1-hour rollback observation window
    │   ├── Regression detected → auto-revert config
    │   └── No regression → mark "effective"
    │
    ├── Inject OAG notification to user
    │   "OAG: I analyzed 4 recent incidents and adjusted recovery parameters."
    │
    └── User perceives: system is more stable
```

### Safety Rails / 安全护栏

| Rail                    | Value                    | Description                                               |
| ----------------------- | ------------------------ | --------------------------------------------------------- |
| Max step                | 50%                      | Single adjustment capped at 50% change / 单次调整上限 50% |
| Max cumulative          | 200%                     | Total drift from original value / 累计偏移上限 200%       |
| Cooldown                | 4 hours                  | Minimum gap between evolutions / 进化间隔至少 4 小时      |
| Observation window      | 1 hour                   | Regression check period after apply / 应用后回归检测期    |
| Rollback trigger        | 5 restarts or 3 failures | Auto-revert threshold / 自动回滚阈值                      |
| Observation persistence | Survives restarts        | Stored in oag-memory.json / 跨重启持久化                  |

### Agent-Assisted Diagnosis / Agent 辅助诊断

When heuristic analysis is insufficient, OAG can escalate to AI agent diagnosis: / 当启发式分析不够时，OAG 可升级到 AI agent 诊断：

- Structured prompt composed from crash history + metrics + config / 从崩溃历史+指标+配置构建结构化 prompt
- JSON response parsing with markdown extraction / JSON 响应解析（含 markdown 提取）
- Low-risk recommendations auto-applied / 低风险建议自动应用
- 4-hour cooldown per trigger type / 每种触发类型 4 小时冷却
- Fully invisible to users / 对用户完全不可见

---

## Architecture / 架构

```
┌──────────────────────────────────────────────────────────┐
│                    Sentinel Pipeline                      │
│  (produces ~/.openclaw/sentinel/channel-health-state.json)│
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                      OAG Runtime                          │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ CLI Surfaces │  │ System Notes │  │ Delivery       │  │
│  │ status/health│  │ one-shot     │  │ Recovery +     │  │
│  │ /doctor      │  │ localized    │  │ Indexed Queue  │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Health      │  │ Language     │  │ Channel        │  │
│  │ Policy      │  │ Detection    │  │ Lifecycle      │  │
│  │ socket+poll │  │ zh/en/ja/ko  │  │ Manager        │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Metrics     │  │ Config       │  │ Schema         │  │
│  │ 9 counters  │  │ 7 params     │  │ v1/v2          │  │
│  │ /health API │  │ hot-reload   │  │ versioning     │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────┬───────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────┐
│                  Self-Evolution Engine                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Persistent  │  │ Post-Recovery│  │ Config         │  │
│  │ Memory      │  │ Analysis     │  │ Write-Back     │  │
│  │ 30-day      │  │ heuristic    │  │ atomic merge   │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Incident    │  │ Evolution    │  │ Idle           │  │
│  │ Collector   │  │ Rollback     │  │ Scheduler      │  │
│  │ runtime     │  │ Guard        │  │ non-blocking   │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Agent       │  │ Evolution    │  │ Event          │  │
│  │ Diagnosis   │  │ Notification │  │ Bus            │  │
│  │ AI-powered  │  │ user-facing  │  │ fs.watch       │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## Key Files / 关键文件

### Core Runtime / 核心运行时

| File                                    | Purpose                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `src/commands/oag-channel-health.ts`    | State parsing + formatting with schema versioning / 状态解析（含 schema 版本化） |
| `src/infra/oag-system-events.ts`        | Note consumption with atomic lock + deduplication / 通知消费（原子锁 + 去重）    |
| `src/infra/session-language.ts`         | Language detection (zh/en/ja/ko) / 语言检测                                      |
| `src/gateway/server-channels.ts`        | Channel lifecycle + recovery hooks / 频道生命周期 + 恢复钩子                     |
| `src/gateway/server.impl.ts`            | Gateway orchestration / Gateway 编排                                             |
| `src/gateway/channel-health-policy.ts`  | Health evaluation (socket + poll) / 健康评估                                     |
| `src/gateway/channel-health-monitor.ts` | Background health loop + metrics / 后台健康循环 + 指标                           |

### Infrastructure / 基础设施

| File                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| `src/infra/oag-metrics.ts`             | 9 metric counters + `/health` endpoint / 指标收集 |
| `src/infra/oag-config.ts`              | 7 config resolvers with defaults / 配置解析器     |
| `src/config/types.oag.ts`              | OAG config type definition / 配置类型定义         |
| `src/infra/oag-config-writer.ts`       | Atomic config write-back / 原子配置写回           |
| `src/infra/outbound/delivery-queue.ts` | Crash-safe delivery queue / 崩溃安全投递队列      |
| `src/infra/outbound/delivery-index.ts` | JSON index for fast lookups / JSON 索引           |
| `src/infra/oag-event-bus.ts`           | EventEmitter bus + fs.watch / 事件总线            |

### Self-Evolution / 自进化

| File                                  | Purpose                                                    |
| ------------------------------------- | ---------------------------------------------------------- |
| `src/infra/oag-memory.ts`             | Persistent lifecycle/incident/evolution storage / 持久记忆 |
| `src/infra/oag-incident-collector.ts` | Runtime incident aggregation / 运行时事件采集              |
| `src/infra/oag-postmortem.ts`         | Post-recovery pattern analysis / 事后分析引擎              |
| `src/infra/oag-evolution-guard.ts`    | Rollback observation + regression detection / 回滚守卫     |
| `src/infra/oag-evolution-notify.ts`   | Evolution notification injection / 进化通知注入            |
| `src/infra/oag-diagnosis.ts`          | Agent-assisted diagnosis prompts / Agent 诊断              |
| `src/infra/oag-scheduler.ts`          | Idle-window task scheduler / 空闲调度器                    |

---

## Test Coverage / 测试覆盖

| Test File                           | Tests   |
| ----------------------------------- | ------- |
| `oag-channel-health.test.ts`        | 25      |
| `oag-system-events.test.ts`         | 14      |
| `channel-health-policy.test.ts`     | 22      |
| `session-language.test.ts`          | 8       |
| `oag-metrics.test.ts`               | 6       |
| `oag-config.test.ts`                | 5       |
| `oag-config-writer.test.ts`         | 4       |
| `oag-memory.test.ts`                | 6       |
| `oag-postmortem.test.ts`            | 4       |
| `oag-incident-collector.test.ts`    | 4       |
| `oag-evolution-guard.test.ts`       | 6       |
| `oag-evolution-notify.test.ts`      | 4       |
| `oag-diagnosis.test.ts`             | 6       |
| `oag-scheduler.test.ts`             | 6       |
| `oag-event-bus.test.ts`             | 5       |
| `oag-evolution.integration.test.ts` | 3       |
| `server-channels.test.ts`           | 5       |
| `delivery-index.test.ts`            | 5       |
| `outbound.test.ts`                  | 66      |
| **Total**                           | **204** |

---

## Troubleshooting / 故障排查

1. `openclaw status` — quick local readout / 快速本地状态
2. `openclaw health --json` — live snapshot with `oagMetrics` / 实时快照含指标
3. Check `~/.openclaw/sentinel/channel-health-state.json` — raw state / 原始状态
4. Check `~/.openclaw/sentinel/oag-memory.json` — evolution history / 进化历史
5. View evolutions: `cat ~/.openclaw/sentinel/oag-memory.json | jq .evolutions`
6. View diagnoses: `cat ~/.openclaw/sentinel/oag-memory.json | jq .diagnoses`
7. Manual config override: `openclaw config set gateway.oag.delivery.recoveryBudgetMs 120000`

---

## Development / 开发

```bash
pnpm install                  # Install dependencies / 安装依赖
pnpm tsgo                     # Type check / 类型检查
pnpm test                     # Run all tests / 运行所有测试

# Run OAG tests only / 仅运行 OAG 测试
pnpm test -- --run \
  src/infra/oag-system-events.test.ts \
  src/infra/oag-memory.test.ts \
  src/infra/oag-postmortem.test.ts \
  src/infra/oag-evolution-guard.test.ts \
  src/infra/oag-evolution.integration.test.ts \
  src/commands/oag-channel-health.test.ts \
  src/gateway/channel-health-policy.test.ts
```

---

## License

See the root [LICENSE](../../LICENSE) file.
