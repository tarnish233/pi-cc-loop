# pi-cc-loop

> 在 Pi 里复刻 Claude Code 的 `/loop`：固定间隔 cron、自选间隔、兜底心跳和底部状态摘要。

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
| 自选间隔 | 模型每轮用 `schedule_wakeup` 决定下次延迟（60–3600s）；在固定间隔的 tick 里调用会被当作多余请求忽略（不报错，只说明下一轮自己会来），避免同一 prompt 跑两份 | `/loop <prompt>` |
| 自然语言间隔 | 命令层认不出时交给模型解析（中英文均可） | `/loop 每30秒 ...` |
| loop.md | 不带 prompt 时运行 `.pi/loop.md`（每次触发重读，改了下一轮生效），没有则跑内置维护 prompt | `/loop`、`/loop 15m` |
| 立即执行 | 创建后马上跑一次，不等首个 cron | 自动 |
| 漏跑合并 | agent 忙时到点只记一次 pending，空闲后发一条 | 自动 |
| 兜底心跳 | 模型忘记调度时 arm 一次 20 分钟心跳，预算 1 次 | 自动 |
| Esc 取消 | 打断属于某个自定步调 loop 的回合（它的 tick、它的 Monitor 唤醒的回合）时取消该 loop；无关回合、空闲时不受影响；固定间隔不受影响 | Esc |
| 错峰 | 周期任务按 id 固定延后最多半个周期（≤30 分钟），间隔本身不变；`:00`/`:30` 的一次性任务最多提前 90 秒 | 自动 |
| 过期 | 周期任务 7 天后最后执行一次再删除；一次性任务不过期 | 自动 |
| 次数上限 | `--max N`，到顶自动删除 | 标志 |
| 持久化 | `--durable` 写入 `.pi/scheduled_tasks.json`；同一项目只由一个 Pi 会话执行 | 标志 |
| 底部摘要 | Pi 底部状态栏一行：`loop 2 · next 3m`，倒计时按分钟变化，无任务时不占位 | `/loop footer on\|off` |
| 详细面板 | 输入框上方的逐任务详情（id、类型、绝对时间、prompt），默认关闭 | `/loop widget on\|off` |

## 命令

```text
/loop [间隔] <prompt>     按间隔重复跑
/loop <prompt>            间隔交给模型判断
/loop [间隔]              运行 .pi/loop.md 或内置维护 prompt（不带间隔则自定步调）
/loop status              列出当前 loop
/loop stop [id]           停止一个或全部
/loop footer on|off       底部摘要
/loop widget on|off       输入框上方的详细面板
/loop settings ...        界面设置
/loop help                帮助
```

标志：`--durable` 写入 `.pi/scheduled_tasks.json`；`--max N` 触发 N 次后自动停止。

agent 忙时输入 `/loop`，会等当前回合结束再开始。

间隔写法：

- `30s`、`5m`、`2h`、`1d`
- `check the deploy every 20m`、`every 5 min`、`every 2 hrs`
- 秒向上取整到分钟；不整除的间隔按 CC 规则取整并提示：`7m` → `*/6`，`30s` → 每分钟
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
- `prompt`：原样传回 `/loop` 的 prompt；裸 `/loop` 传 `<<loop.md>>`
- `stop`：结束当前自选间隔 loop

`schedule_wakeup` 调用后本回合结束（工具批次里只有它时），所以模型会先写进度再调用；
延迟按你给的值使用（四舍五入到整秒），只有超出 60–3600 秒才会被 clamp 并提示。CC 会把 `*/5` 任务提前 15 秒、把 286–300 秒的延迟压到 285 秒来保温 5 分钟的 prompt 缓存，我们没有跟：现在的缓存能活几十分钟到几小时，这样改只会让间隔变成 4 分 45 秒。

## 持久化与恢复

- `--durable` / `durable: true` 的任务存在 `.pi/scheduled_tasks.json`，并自动加入 `.git/info/exclude`
- 同一项目只有持有 `.pi/scheduled_tasks.lock` 的 Pi 会话执行它们；该会话退出（或 60 秒没有心跳）后由其他会话接管
- Pi 没运行时错过的 durable 一次性任务会被移除，下一轮先问你要不要补跑
- 从别的目录拷来的任务只列出、不执行；`.pi` 或任务文件是符号链接时拒绝写入
- 恢复会话：会话内任务照常恢复，但过期的周期任务、已过时间的一次性任务除外，错过的运行不补跑；自定步调 loop 不恢复（需重新 `/loop`），`/reload` 时保留

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
/loop settings footer on|off
```

- 已画出的旧行需要 `/reload` 才会换样式
- 环境变量覆盖：`PI_CC_COMPACT_MESSAGES=0`、`PI_CC_COMPACT_TOOL_ROWS=0`、`PI_CC_MANAGE_CCSTYLE=0`、`PI_CC_FOOTER=0`

## 底部摘要

`ctx.ui.setStatus("loop", …)` 是 Pi 核心 API，不依赖任何其他扩展：

| 场景 | 显示 |
| --- | --- |
| 没有任务 | 不设置状态，footer 不会被多占一行 |
| 有任务 | `loop 3 · next 4m`（数量 + 最近一次触发） |
| 一分钟内 | `loop 1 · next <1m` |
| 超过一小时 | `loop 1 · next 2h 15m` |

- 倒计时取整到分钟，配合"文本相同就不调用"的去重，最多每分钟重绘一次（Pi 每次 `setStatus` 都会触发重绘）
- 装了 `pi-cc-extensions`：这一行会作为它的一个 chip 出现在第 2 行，可在它的配置面板里移动或隐藏；它会把 ANSI 去掉，所以这里只用纯文本
- 没装 `pi-cc-extensions`：Pi 内置 footer 会把它和其他扩展的状态拼成一行，加在用量行下面，只在有任务时出现

> 如果装了 `pi-cc-extensions`，`tools on` 会把本扩展的工具名加入它的 `excludeRenderers`；
> `tools off` 只移除自己加过的名字。它只在启动时读配置，切换后需要 `/reload`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_LOOP_MAX_AGE_DAYS` | `7` | 任务最长存活天数，`0` 不过期 |
| `PI_LOOP_KEEPALIVE_SECONDS` | `1200` | 兜底心跳；`0` 禁用 |
| `PI_LOOP_JITTER` | `0.5` | 周期任务最多延后的周期比例；`0` 关闭错峰 |
| `PI_LOOP_SCAN_MS` | `1000` | 调度扫描间隔 |
| `PI_CC_FOOTER` | `1` | 底部摘要；`0` 关闭（两个 pi-cc 包共用） |

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
- Esc 只取消被打断回合所属的自定步调 loop；CC 在任何时候按 Esc（包括空闲、打断无关回合）都会取消所有自定步调 loop。其他情况用 `/loop stop`。
- 底部摘要默认开启，是 CC 没有的（CC 主会话不显示 loop 状态）；详细面板默认关闭。
- `cron_create` 的 `maxFires` 是额外加固；CC 没有次数上限。
- `/loop stop` 会连带静默停掉该 chain 绑定的 Monitor。
- Monitor 事件不会取消待触发的 wakeup，它始终是兜底心跳（与 CC 一致）。

## 许可证

MIT
