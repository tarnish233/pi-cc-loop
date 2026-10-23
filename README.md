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

## 工作方式

`/loop` 和 CC 一样是一个**技能**，不是用代码直接排任务：你输入的内容会作为一条普通 user 消息进入对话，
模型自己解析间隔并调用工具完成。所以对话里始终能看到你要求了什么、模型做了什么。

| 功能 | 说明 | 入口 |
| --- | --- | --- |
| 固定间隔 | 模型用 `cron_create` 建一个 cron（`5m` → `*/5 * * * *`），然后立即执行一次；触发时按"定时任务"呈现 | `/loop 5m <prompt>`、`/loop 每分钟 ...` |
| 自选间隔 | 运行一次后用 `schedule_wakeup` 决定下次延迟（60–3600s） | `/loop <prompt>` |
| loop.md | 请求本身没有任务时（裸 `/loop` 或只给间隔）由 `.pi/loop.md` 提供，每次触发重读；首轮由模型自己读文件 | `/loop`、`/loop 15m` |
| 停止 / 查看 | 也走对话：模型用 `cron_list` / `cron_delete`（自选间隔用 `schedule_wakeup` + `stop: true`）；停掉后再输入同一个 `/loop` 会重新开始 | `/loop stop`、`/loop status` |
| 回合中输入 | 模型正在回复时输入 `/loop ...`：底部提示"will start when the current turn ends"，当前回合结束后作为新的一轮开始（不会混进正在进行的回合） | 自动 |
| 漏跑合并 | agent 忙时到点只记一次 pending，空闲后发一条 | 自动 |
| 兜底心跳 | 模型忘记调度时 arm 一次 20 分钟心跳，预算 1 次 | 自动 |
| Esc 取消 | 打断属于某个自定步调 loop 的回合（它的 tick、它的 Monitor 唤醒的回合）时取消该 loop；无关回合、空闲时不受影响；固定间隔不受影响 | Esc |
| 错峰 | 周期任务按 id 固定延后最多半个周期（≤30 分钟），间隔本身不变；`:00`/`:30` 的一次性任务最多提前 90 秒 | 自动 |
| 过期 | 周期任务 7 天后最后执行一次再删除；一次性任务不过期 | 自动 |
| 次数上限 | `maxFires`，到顶自动删除 | 模型传参 |
| 持久化 | `durable: true` 写入 `.pi/scheduled_tasks.json`；同一项目只由一个 Pi 会话执行 | 模型传参 |
| 底部摘要 | Pi 底部状态栏一行：`loop 2 · next 3m`，无任务时不占位 | `/loop footer on\|off` |
| 界面设置 | 仍是本地命令，不进对话 | `/loop settings ...` |

## 命令

```text
/loop [间隔] <prompt>     交给模型：按间隔重复，或自选节奏
/loop <prompt>            交给模型：自选间隔
/loop [间隔]              交给模型：跑 .pi/loop.md 或内置维护 prompt
/loop status              交给模型：列出当前 loop
/loop stop [id]           交给模型：停止一个或全部
/loop footer on|off       本地：底部摘要
/loop settings ...        本地：界面设置
/loop help                本地：帮助
```

前五个会作为普通 user 消息进入对话（内容就是你输入的那行），模型再按技能说明调用
`cron_create`、`cron_list`、`cron_delete`、`schedule_wakeup`。后三个只改界面，不进对话。

间隔写法没有约束，模型自己解析：`30s`、`5m`、`2h`、`1d`、`check the deploy every 20m`、
`每2分钟输出一次`、`每分钟打印一次hi` 都可以。小于一分钟会向上取整到每分钟。

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

> 本扩展不写其他插件的配置文件。如果你之前在 `pi-cc-extensions.json` 里因为旧版本加过
> `cron_create`、`cron_delete`、`cron_list`、`schedule_wakeup` 这几条 `excludeRenderers`，
> 现在可以删掉：工具行由 Pi 或 pi-cc-extensions 自己渲染。

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
