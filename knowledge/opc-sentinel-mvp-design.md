# OPC Sentinel MVP 设计说明

## 名称

`OPC Sentinel`

含义：

- `OPC` = `OpenClaw`
- `Sentinel` = 守望、巡检、异常标记、恢复准备层

它不是普通的“看门狗”命名，而是专门服务于当前这套 OpenClaw 多 agent 编排架构的后台守望组件。

---

## 目标

为长任务和复杂任务补上一层静默后台能力：

- 不依赖聊天上下文记忆任务是否完成
- 定期扫描正在运行的 task bus
- 为超时任务记录 heartbeat / stuck 事件
- 定期备份 `openclaw.json`
- 为 follow-up 编排和后续人工/主控处理提供结构化输入

---

## MVP 目前实现了什么

脚本位置：

- [`skills/task-orchestrator/scripts/opc_sentinel.py`](../skills/task-orchestrator/scripts/opc_sentinel.py)

### 当前功能

#### 1. 扫描 task bus

扫描目录：

- `~/.openclaw/orchestrator/tasks/TASK-.../`

只处理：

- `status.json.state == "running"` 的任务

#### 2. 静默记录 heartbeat

当任务长时间没有 phase 更新时：

- 写入 `events.jsonl`
- 更新 `status.json.heartbeat_at`

默认阈值：

- `--heartbeat-seconds 90`

#### 3. 标记 stuck

当任务超过卡死阈值时：

- 更新 `status.json.state = blocked`
- `blocked = true`
- 写入 `run_stuck` 事件

默认阈值：

- `--stuck-seconds 300`

#### 4. 备份 `openclaw.json`

默认会做：

- 定期把 `~/.openclaw/openclaw.json` 复制到：
  - `~/.openclaw/backups/openclaw-json/`

并做滚动保留：

- `--max-backups 20`

#### 5. 被动观察 gateway 健康

当前通过：

- `openclaw gateway status`

做一次观测性检查。

如果失败：

- 仅记录观测结果到 sentinel 状态文件
- 不再由 `OPC Sentinel` 负责 gateway 恢复或 restart 编排

---

## 当前没有做什么

为了控制风险，MVP **默认不做**下面这些激进动作：

- 不自动 kill 子进程
- 不自动重启 subagent run
- 不自动恢复 `openclaw.json`
- 不直接对用户发消息
- 不直接替代 `main`

也就是说它当前是：

**观测 + 记录 + 标记**

而不是：

**直接接管 + 强制修复**

---

## 设计原则

### 1. `main` 仍然是唯一对外发声口

`OPC Sentinel` 是后台静默组件，不应直接对用户说话。

它的职责是：

- 发现问题
- 记录状态
- 写事件

最终仍应由 `main` 读取 task bus 或 sentinel 结果后对用户汇报。

### 2. 不靠脑内记忆，靠状态文件

`OPC Sentinel` 不依赖聊天上下文。

它依赖：

- `status.json`
- `events.jsonl`
- `run_id`
- `child_session_key`
- `last_update_at`
- `heartbeat_at`

### 3. 先可观测，再自动恢复

今天先做的是最稳的一步：

- 先看得见问题
- 先记录问题
- 再考虑自动 kill / retry / restore

这是为了避免在没有足够保护的情况下，后台静默误伤任务或配置。

---

## 当前状态字段扩展

今天为了支撑 `OPC Sentinel`，task bus 的默认状态结构已经扩展了这些字段：

- `phase`
- `phase_owner`
- `last_update_at`
- `heartbeat_at`
- `retry_count`
- `run_id`
- `child_session_key`
- `job_ref`
- `stuck_after_seconds`

相关脚本：

- [`skills/task-orchestrator/scripts/init_task.py`](../skills/task-orchestrator/scripts/init_task.py)
- [`skills/task-orchestrator/scripts/update_task.py`](../skills/task-orchestrator/scripts/update_task.py)

---

## 推荐周期

MVP 当前默认值：

- 首次心跳观察：约 `90s`
- 默认 stuck 阈值：约 `300s`

更完整的建议节奏：

- `15s`：确认 run 已启动
- `45s`：第一次静默健康检查
- `90s`：第一次 heartbeat
- `180s`：高风险停滞检查
- `300s`：标记 blocked / stuck

---

## 后续可扩展方向

### 阶段 2

- 支持 `retry_count`
- 支持受控 restart
- 支持针对具体 `run_id` 的 kill / retry

### 阶段 3

- 支持更细粒度的 task follow-up 分类
- 支持更稳定的 blocked / retry review 流转
- gateway / channel 恢复继续交给 upstream OpenClaw runtime

### 阶段 4

- 如果 OpenClaw 底层支持，接入 parent-only result delivery
- 将 sentinel 结果直接融入主 orchestrator 状态机

---

## 运行方式

最简单运行：

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/opc_sentinel.py
```

带参数运行：

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/opc_sentinel.py \
  --heartbeat-seconds 90 \
  --stuck-seconds 300 \
  --max-backups 20
```

---

## 一句话定义

`OPC Sentinel` 是当前 OpenClaw 多 agent 编排体系里的后台静默守望层，主要负责盯住长任务、记录异常、生成 follow-up，并把 gateway 恢复职责留给 upstream OpenClaw runtime。 

---

## V2 已实现能力

今天继续补到第二版后，`OPC Sentinel` 额外支持了受控恢复钩子：

### 1. 忽略普通 warning

gateway 健康判断不再把普通 warning 直接判成红色故障。

当前更关注真正的硬故障：

- `RPC probe failed`
- `config invalid`
- `gateway closed`
- `gateway port not listening`

### 2. 受控 kill stuck pid

如果任务状态里有：

- `pid`

并且运行时启用了：

- `--kill-stuck-pids`

那么超过卡死阈值后，`OPC Sentinel` 可以尝试发送 `SIGTERM`。

### 3. 受控 retry

如果任务状态里有：

- `retry_command`

并且运行时启用了：

- `--allow-retry`

那么在重试预算内，`OPC Sentinel` 可以尝试重启任务，并更新：

- `retry_count`
- `pid`
- `last_update_at`

### 4. 当前边界更新

在升级到较新的 upstream OpenClaw 版本后，gateway / channel 恢复职责已经更多下沉到官方 runtime：

- channel health monitor
- launchd repair helpers
- gateway run-loop restart hardening

因此 `OPC Sentinel` 现阶段不再默认承担：

- config restore
- gateway launchctl restart
- recovery request 编排

当前更推荐把它收敛为：

- task bus 监督
- heartbeat / blocked 事件
- follow-up 生产层
