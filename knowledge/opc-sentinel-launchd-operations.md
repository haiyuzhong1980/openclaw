# OPC Sentinel Launchd 运维说明

## 目标

把 `OPC Sentinel` 从手动脚本升级成后台定时调度组件，让它定期静默运行。

当前定位已经收敛：

- `OPC Sentinel` 负责任务层监督
- upstream OpenClaw runtime 负责 gateway / channel 恢复

这里分两种：

- `LaunchAgent`
  - 用户登录后后台运行
- `LaunchDaemon`
  - 更接近系统启动级别，随机器起来

## 当前推荐架构

现在优先推荐的形态是：

- `LaunchAgent`
  - 用户登录后自动加载
  - 每隔固定间隔运行一次 `opc_sentinel.py`
  - 扫描 task bus
  - 写 heartbeat / blocked 事件
  - 产出 follow-up

`LaunchDaemon` 现在不再是默认推荐路径，除非你明确要做系统级巡检实验。

## 相关文件

- 安装脚本：
  [`skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py`](../skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py)
- 卸载脚本：
  [`skills/task-orchestrator/scripts/uninstall_opc_sentinel_launchd.py`](../skills/task-orchestrator/scripts/uninstall_opc_sentinel_launchd.py)
- daemon 安装脚本：
  [`skills/task-orchestrator/scripts/install_opc_sentinel_daemon.py`](../skills/task-orchestrator/scripts/install_opc_sentinel_daemon.py)
- daemon 卸载脚本：
  [`skills/task-orchestrator/scripts/uninstall_opc_sentinel_daemon.py`](../skills/task-orchestrator/scripts/uninstall_opc_sentinel_daemon.py)
- 运行脚本：
  [`skills/task-orchestrator/scripts/opc_sentinel.py`](../skills/task-orchestrator/scripts/opc_sentinel.py)

## 安装

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py \
  --interval-minutes 1 \
  --heartbeat-seconds 90 \
  --stuck-seconds 300 \
  --max-backups 20
```

默认行为：

- 写入：
  `~/Library/LaunchAgents/ai.openclaw.opc-sentinel.plist`
- 立刻 `bootstrap`
- 立刻 `kickstart`

## 只生成 plist

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/install_opc_sentinel_launchd.py \
  --write-only
```

适合先检查内容再手动加载。

## 卸载

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/uninstall_opc_sentinel_launchd.py
```

## 安装为 LaunchDaemon

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/install_opc_sentinel_daemon.py \
  --interval-minutes 10 \
  --heartbeat-seconds 90 \
  --stuck-seconds 300 \
  --max-backups 20
```

这个版本会写入：

- `/Library/LaunchDaemons/ai.openclaw.opc-sentinel.daemon.plist`

适合你明确要求“随系统启动而启动”的场景。

## 卸载 LaunchDaemon

```bash
python3 ~/.openclaw/workspace/skills/task-orchestrator/scripts/uninstall_opc_sentinel_daemon.py
```

## 日志

- 标准输出：
  `~/.openclaw/logs/opc-sentinel.log`
- 标准错误：
  `~/.openclaw/logs/opc-sentinel.err.log`

## 推荐参数

### 默认推荐

- `interval-minutes = 1`
- `heartbeat-seconds = 90`
- `stuck-seconds = 300`
- `max-backups = 20`
- 默认不启用 gateway 恢复参数

如果后面要尝试更激进的 task retry，再单独打开：

- `--allow-retry`
- `--kill-stuck-pids`

### 更保守

- `interval-minutes = 10`
- `heartbeat-seconds = 180`
- `stuck-seconds = 600`

适合不希望后台太频繁动的场景。

## 当前已知边界

- 现在是 MVP
- 默认不自动 kill 任务
- 默认不自动 retry 子代理
- 默认不自动恢复 gateway / config
- 目前主要是：
  - 静默检查
  - 写事件
  - 标记 stuck
  - 备份配置
  - 观察 gateway 状态

## V2 可选能力

脚本已经支持，但默认不在 launchd 中开启：

- `--kill-stuck-pids`
- `--allow-retry`
- `--max-task-retries`

## 已发现的现状

当前环境下，`OPC Sentinel` 仍然会记录 gateway 观测结果，但不再负责 gateway 恢复。主要价值在于：

- 长任务 heartbeat
- stuck / blocked 标记
- follow-up 队列
- 给主控或后续 orchestrator 提供结构化待办

## 一句话

`OPC Sentinel` 的 launchd 版，目的是让长任务监督从“手动执行”变成“后台定时静默执行”，而不是重复接管 gateway 恢复。 
