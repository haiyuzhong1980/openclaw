# 2026-03-09 OPC Sentinel / Orchestrator 需求文档

## 1. 产品定位

目标不是把 OpenClaw 做成更会聊天的 bot，而是把它做成：

- 稳定的生产力执行系统
- 可追踪的多 agent 任务平台
- 具备监督、恢复、继续推进能力的工具层

一句话：

**自然语言只是输入方式，任务执行、状态跟踪、恢复能力才是核心产品。**

---

## 2. 核心目标

把当前系统做成一个**稳定、可追踪、可恢复的任务执行平台**，用户通过自然语言发起工作，但系统内部默认走工程化执行流，而不是聊天流。

### 成功标准

1. 执行型请求不会停留在聊天式处理。
2. 执行型请求默认进入 tracked task。
3. 长任务执行期间有持续状态更新。
4. `OPC Sentinel` 能监督任务，并为 gateway 提供观察信息而不是重复恢复。
5. follow-up 能被 orchestrator 消费和关闭。
6. `main` 是唯一对外发声口。
7. 用户只在真正需要判断时被打扰。
8. 任务开始执行后，用户必须能在渠道侧看到明确的“正在处理”反馈，而不是长时间静默。

---

## 3. 当前问题定义

当前系统已经具备：

- task bus
- tracked execution
- `OPC Sentinel`
- follow-up queue
- gateway observation

但关键问题仍然存在：

### 3.1 执行入口不稳定

即使 execution intent 已经明显，`main` 仍可能：

- 在主会话里直接 `exec`
- 以聊天式形式执行
- 不创建 `TASK-...`
- 不走 `orchestrator_runtime.py`

结果：

- `OPC Sentinel` 盯不住
- 长任务容易黑箱
- 跟进、重试、恢复都缺少状态依据

### 3.2 busy queue 场景退化

碎片消息在 busy session 里被合并后，即使已经是 execution intent，仍然可能退化成：

- queued chat continuation
- 普通主会话回复
- 非 tracked 执行

### 3.3 生产力属性还没完全盖过聊天属性

当前仍然经常出现：

- 聊天式接话
- 聊天式组织答案
- 先回复，再执行
- 执行后不进入标准任务流

这与“稳定生产力工具”的目标不一致。

---

## 4. 范围内需求

## 4.1 Smart Message Handler

职责：

- 合并碎片消息
- 识别 `input_finalized`
- 判断用户意图
- 输出 routing signal

它不负责：

- 创建 task
- 写 task bus
- 调 `OPC Sentinel`

### 需要输出的核心字段

- `input_finalized`
- `intent_type`
- `intent_confidence`
- `execution_required`
- `suggest_create_task`
- `queue_mode`
- `route_mode`
- `reason`

### route_mode 建议值

- `chat`
- `orchestrated_execution`
- `followup_processing`

### 关键规则

如果满足以下条件：

- `session_busy = true`
- `input_finalized = true`
- `intent_type = "execution"`

则：

- 不能继续当作普通 continuation
- 必须输出 execution-oriented route signal

---

## 4.2 Main 路由层

这是当前最关键的实现点。

### 目标

让 `main` 在收到 execution intent 后，不再自由选择聊天式执行，而是**优先走统一 orchestrator 入口**。

### 路由规则

#### chat

如果：

- `intent_type = chat`
- `execution_required = false`

则：

- 正常聊天回复
- 不建 task
- 不走 tracked runtime

#### orchestrated_execution

如果：

- `input_finalized = true`
- `intent_type = execution`
- `execution_required = true`

则：

- 默认进入 `orchestrator_runtime.py start-tracked`
- 不允许直接自由 `exec`
- 不允许先聊天再补 task
- 必须尽快触发渠道侧 processing indicator（例如 Telegram typing、Feishu reaction）

#### followup_processing

如果：

- `intent_type = followup`

或：

- 系统存在 pending follow-up

则：

- 优先进入 `orchestrator_runtime.py next-followup`
- 处理完成后调用 `resolve-followup`

---

## 4.3 Canonical Task Bus

标准结构：

- `spec.md`
- `plan.md`
- `status.json`
- `events.jsonl`
- `handoff.md`
- `result.md`

要求：

- 多步任务必须有 `TASK-...`
- 任务状态必须持续更新
- chat output 必须与 task bus 一致

---

## 4.4 Tracked Execution

执行型任务默认走 tracked runtime。

### 标准入口

- `orchestrator_runtime.py start-tracked`

### 执行要求

- 真实执行过程中持续更新 `last_update_at`
- 写入 pulse / runtime events
- 任务结束时进入：
  - `completed`
  - `failed`
  - `blocked`
- 任务启动后应立即触发用户可见的 processing indicator，并在完成/失败后及时清除或切换为结果状态

### 禁止事项

- 建 task 但真实执行脱离 task bus
- 只靠聊天内容当状态来源

---

## 4.5 OPC Sentinel

`OPC Sentinel` 继续承担两类职责：

### A. Task Supervision

- 扫描 `running` task
- 检测 heartbeat / stuck / retry / blocked
- 产出 follow-up request

### B. Gateway Observation

- 采集 `openclaw gateway status` 结果
- 标记当前观测到的 failure kind
- 不再由 `OPC Sentinel` 直接负责 restart / restore

原则：

- gateway / channel 恢复优先交给 upstream OpenClaw runtime
- `OPC Sentinel` 不与官方 watchdog / health-monitor 重复接管

---

## 4.6 Follow-up Queue

目录：

- `~/.openclaw/sentinel/task-followups/`

当前 follow-up 类型：

- `heartbeat_review`
- `retry_review`
- `blocked_review`

### 标准入口

- `orchestrator_runtime.py next-followup`
- `orchestrator_runtime.py resolve-followup`

### 规则

- pending follow-up 是 orchestrator state 的一部分
- claimed follow-up 不能挂着不处理
- follow-up 关闭动作必须回写 task event

---

## 4.7 Single-Speaker Model

产品层要求：

- 用户只和 `main` 说话
- `subagent` / worker / sentinel 都是内部层
- 对用户只有一个统一发声口

这条规则的目标不是更像聊天，而是：

- 减少重复消息
- 减少旧 completion 污染
- 保证状态表达统一

## 4.8 User-visible Processing Indicators

产品层要求：

- Telegram：执行型任务开始后，应出现 `typing`
- Feishu：执行型任务开始后，应出现可见 reaction / processing indicator
- indicator 应由主入口统一控制，不依赖 subagent 直接对用户发声
- indicator 的出现时机要早于任务结果，不能等任务做完才让用户知道系统在处理
- indicator 停止或切换结果状态要和 task lifecycle 对齐

---

## 5. 范围外需求

当前阶段先不做：

- 完美自然语言理解
- 100% 消除所有重复消息
- 全量 dashboard
- 所有渠道完全一致体验
- 完整插件市场整合
- 完整 inbox/outbox agent factory

---

## 6. 验收标准

## 6.1 执行型碎片输入

输入示例：

- `帮我看一下`
- `clawhub 上有没有 backup skill`
- `找到后总结一下。完了`

预期：

- 识别为 execution
- route 到 orchestrated execution
- 创建 `TASK-...`
- 不走普通聊天式处理

## 6.2 busy queue

当 session busy 时继续输入执行请求。

预期：

- 不当普通 continuation
- 仍 route 到 orchestrated execution

## 6.3 长任务

预期：

- 有 phase plan
- 有 checkpoint
- 超时有 heartbeat
- 最终状态明确
- 用户在等待期间能看到渠道侧 processing indicator，不会误判为系统无响应

## 6.4 follow-up

预期：

- stuck task 产出 follow-up
- orchestrator 可消费
- 可 resolve
- task `events.jsonl` 可见 follow-up 生命周期

## 6.5 gateway

预期：

- 连续失败达到阈值才恢复
- 普通 warning 不触发恢复
- 真挂时可自动恢复

---

## 7. 当前优先级

当前阶段最高优先级不是继续增强 `OPC Sentinel`，而是：

1. `smart-message-handler` 输出稳定 routing signal
2. `main` 强制执行：
   - `execution intent -> orchestrator_runtime.py`
3. 所有执行型任务默认 tracked
4. orchestrator 自动消费 follow-up
5. `OPC Sentinel` 持续监督

---

## 8. 对参考项目的可借鉴点

参考了 `agent-orchestrator` 这个 skill 包后，可以确认：

- 它也是“Python/脚本 + md/json + 文件协议收敛”的路线
- 它强调：
  - 任务分解
  - 文件式状态跟踪
  - 子 agent 生命周期
  - orchestrator 负责收敛

### 可借鉴部分

- 明确 agent 生命周期
- 明确状态文件协议
- 明确 orchestrator 只做调度和收敛

### 不必照搬部分

- 不必把我们当前结构改成它的 `inbox/outbox` 目录模式
- 我们现有的：
  - `TASK-...`
  - `status.json`
  - `events.jsonl`
  - `OPC Sentinel`
  - follow-up queue
  已经形成了自己的协议

结论：

**方向一致，可借鉴思路，但继续沿用我们自己的 task bus + tracked execution + Sentinel 架构。**

---

## 9. 一句话总结

**当前最核心的需求，不是让 OpenClaw 更会聊天，而是让 execution intent 稳定进入 orchestrator runtime，并在 task bus / OPC Sentinel / follow-up queue 的闭环里运行。**
