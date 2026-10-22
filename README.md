# pi-cc-loop

> 在 Pi 里复刻 Claude Code 的 `/loop`：固定间隔 cron、自选间隔、兜底心跳和可选状态条。

## 快速开始

```bash
# 本地开发：把仓库软链接到 Pi 扩展目录
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-loop

# 发布后
pi install npm:pi-cc-loop
```

安装后执行 `/reload`。

## 功能

| 功能 | 说明 | 入口 |
| --- | --- | --- |
| 固定间隔 | 5 字段 cron；`30s`、`5m`、`2h`、`1d`；秒向上取整到分钟 | `/loop 5m <prompt>` |
| 自选间隔 | 模型每轮用 `schedule_wakeup` 决定下次延迟（60–3600s） | `/loop <prompt>` |
| 自然语言间隔 | 命令层认不出时交给模型解析（中英文均可） | `/loop 每30秒 ...` |
| 立即执行 | 创建后马上跑一次，不等首个 cron | 自动 |
| 漏跑合并 | agent 忙时到点只记一次 pending，空闲后发一条 | 自动 |
| 兜底心跳 | 模型忘记调度时 arm 一次 20 分钟心跳，预算 1 次 | 自动 |
| 次数上限 | `--max N`，到顶自动删除 | 标志 |
| 持久化 | `--durable` 写入 `.pi/scheduled_tasks.json` | 标志 |
| 状态条 | 输入框上方状态行，默认关闭 | `/loop widget on\|off` |

## 命令

```text
/loop [间隔] <prompt>     按间隔重复跑
/loop <prompt>            间隔交给模型判断
/loop                     使用 .pi/loop.md 或内置维护 prompt
/loop status              列出当前 loop
/loop stop [id]           停止一个或全部
/loop widget on|off       状态条
/loop settings ...        界面设置
/loop help                帮助
```

标志：`--durable` 写入 `.pi/scheduled_tasks.json`；`--max N` 触发 N 次后自动停止。

agent 忙时输入 `/loop`，会等当前回合结束再开始。

间隔写法：

- `30s`、`5m`、`2h`、`1d`
- `check the deploy every 20m`
- 不整除的间隔按 CC 规则取整并提示：`7m` → `*/6`，`30s` → 每分钟
- 其他语言（如「每30秒」）交给模型解析

## 工具

| 工具 | 说明 |
| --- | --- |
| `cron_create` | 创建固定间隔任务；支持 `recurring`、`durable`、`maxFires` |
| `cron_delete` | 按 id 取消 |
| `cron_list` | 列出任务 |
| `schedule_wakeup` | 自选间隔：安排下次唤醒，或 `stop: true` 结束 |

`schedule_wakeup` 参数：

- `delaySeconds`：60–3600，越界自动钳制
- `reason`：一句原因
- `prompt`：原样传回 `/loop` 的 prompt
- `stop`：结束当前自选间隔 loop

## 设置

两个 pi-cc 扩展共享 `~/.pi/agent/pi-cc.json`：

```jsonc
{
  "compactMessages": true,          // 两行 marker / 旧的带底色卡片
  "compactToolRows": true,          // 一行工具结果 / Pi 默认工具行
  "managePiCcExtensions": true      // 自动维护 pi-cc-extensions 的 excludeRenderers
}
```

用命令切换：

```text
/loop settings
/loop settings messages on|off
/loop settings tools on|off
```

- 已画出的旧行需要 `/reload` 才会换样式
- 环境变量覆盖：`PI_CC_COMPACT_MESSAGES=0`、`PI_CC_COMPACT_TOOL_ROWS=0`、`PI_CC_MANAGE_CCSTYLE=0`

> 如果装了 `pi-cc-extensions`，`tools on` 会把本扩展的工具名加入它的 `excludeRenderers`；
> `tools off` 只移除自己加过的名字。它只在启动时读配置，切换后需要 `/reload`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_LOOP_MAX_AGE_DAYS` | `7` | 任务最长存活天数，`0` 不过期 |
| `PI_LOOP_KEEPALIVE_SECONDS` | `1200` | 兜底心跳；`0` 禁用 |
| `PI_LOOP_JITTER` | `0` | 抖动比例 0–1 |
| `PI_LOOP_SCAN_MS` | `1000` | 调度扫描间隔 |

## 兼容性

- Node.js `>=22.19.0`
- Pi `1.3.0`（开发环境）
- 与 `pi-cc-extensions` 共存，见上面的设置说明

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

## 说明

- 行为对齐 Claude Code v2.1.306 的 `/loop`，用 Pi 扩展 API 实现。
- `/loop stop` 代替 CC 的 Esc；状态条默认关闭，和 CC 主会话一致。
- `cron_create` 的 `maxFires` 是额外加固；CC 没有次数上限。
- `/loop stop` 会连带静默停掉该 chain 绑定的 Monitor。
- Monitor 事件不会取消待触发的 wakeup，它始终是兜底心跳（与 CC 一致）。

## 许可证

MIT
