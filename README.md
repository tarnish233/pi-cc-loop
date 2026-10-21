# pi-cc-loop

给 Pi coding agent 实现的、**行为对齐 Claude Code v2.1.306 `/loop`** 的调度扩展。

不是「一个能重复跑 prompt 的循环」，而是照着 Claude Code 二进制里的实际实现做的：
同样的 cron 语义、同样的调度时机、同样的投递优先级、同样的兜底心跳预算。

---

## 用法

```
/loop [间隔] <prompt>     按间隔重复跑 prompt
/loop <prompt>            间隔交给模型判断（固定间隔就建 cron，开放式就自选间隔）
/loop                     用 .pi/loop.md 里的任务；没有就用内置的维护 prompt
/loop stop [id]          停掉某个 loop（或全部）
/loop status              列出当前所有 loop
/loop widget on|off       显示/隐藏输入框上方的状态行（默认关，和 CC 一致）
/loop help                帮助
```

> `/loop <prompt>` 里如果写了间隔（`5m`、`every 20m`，或者任何语言写的
> 「每30秒」），都会由**模型**来解析和取整 —— 和 Claude Code 一样。
> 详见下面的「谁来定间隔」。

### 间隔的写法

和 Claude Code 完全一致的解析优先级（**只认英文 token**，和 CC 的 skill prompt 一样）：

1. **开头是间隔 token**：`/loop 5m check the deploy` → `5m` 是间隔，其余是 prompt
2. **结尾是 every 子句**：`/loop check the deploy every 20m` → `20m` 是间隔
3. **都没有** → 见下面「谁来定间隔」

支持的单位：`30s`、`5m`、`2h`、`1d`，也支持 `every 5 minutes` 这种写法。

> `check every PR` 不会被误判成间隔——只有 `every` 后面跟真实时间单位才会。

### 谁来定间隔（和 Claude Code 一样，交给模型）

Claude Code 的 `/loop` 是一个 **skill**，所以**模型自己读你的输入、套用 skill 的规则**。
这带来一个重要结果：**用任何语言写的间隔，模型都能理解**。

你截图里 CC 对 `/loop 每30秒打印一次hello world` 的处理就是：

> I'll parse this input: "每30秒打印一次hello world" means "print hello world every 30 seconds."
> One constraint: the cron scheduler's minimum granularity is 1 minute... I round 30s up to ceil(30/60) = 1 minute.

这里也是同一套机制：

- 命令层只认上面那两种**英文 token** 形式
- 认不出来时，**不建任何任务**，而是把 Claude Code skill prompt 的规则注入给模型：
  怎么把间隔换算成 5 字段 cron、**秒要向上取整到分钟**、不整除就取整到最近的整除值并告知用户，
  以及「间隔不明确就用 `schedule_wakeup` 自选间隔」
- 模型读完你的原话后自己决定：固定间隔就调 `cron_create`，开放式就调 `schedule_wakeup`

所以 `/loop 每30秒输出一次hello world` 在这里的表现和 CC 一致：
**模型理解为 30 秒 → 向上取整到 1 分钟 → 建 `* * * * *` 的 cron job → 告诉你「30s 被取整到 1 分钟」**。

### 取整规则

命令层能直接解析出间隔时，规则和 CC 相同：

| 你写的 | 实际 | 说明 |
| --- | --- | --- |
| `30s` | 每 1 分钟 | 向上取整，cron 最小粒度是 1 分钟 |
| `7m` | 每 6 分钟 | 取整到最近的整除值，并告知你 |
| `5m` | 每 5 分钟 | 正好整除，不动 |
| `1h` | 每小时 | |

取整发生时，通知里会带上原因（`30s rounded up to 1 minute ...`）。

### 标志

| 标志 | 作用 |
|---|---|
| `--durable` | 额外写一份到 `<项目>/.pi/scheduled_tasks.json`，重启 Pi 后自动恢复 |
| `--max N` | 触发 N 次后自动停 |

可以出现在任何位置：`/loop 5m ping --max 10 --durable`。

### 默认 prompt（loop.md）

`/loop` 不带参数时，按顺序找：

1. `<项目>/.pi/loop.md`
2. `~/.pi/loop.md`

找到就把文件内容当作任务跑。都没找到就用内置的维护 prompt（对齐 Claude Code 的
maintenance prompt）：继续未完成的工作、处理当前分支的 PR（review comments / CI / 冲突）、
没事做的时候跑清理（bug hunt / simplify）。

---

## 模型可调用的工具

| Pi 工具 | Claude Code 对应 | 说明 |
| --- | --- | --- |
| `cron_create` | `CronCreate` | 按 5 字段 cron 建一个任务，返回 job id |
| `cron_delete` | `CronDelete` | 按 id 取消任务 |
| `cron_list` | `CronList` | 列出当前任务 |
| `schedule_wakeup` | `ScheduleWakeup` | 自选间隔模式下选下次延迟，或 `stop: true` 结束 |

### `schedule_wakeup` 的参数

```jsonc
{
  "delaySeconds": 1200,          // 会被钳制到 [60, 3600]
  "reason": "CI 还在跑，等久一点",  // 一句话，给用户看
  "prompt": "check the deploy",  // 原样回传 /loop 的 prompt
  "stop": false                  // true 表示结束这条 chain
}
```

---

## 对齐 Claude Code 的细节

下面每一条都是从 Claude Code v2.1.306 的二进制和运行时 prompt 里核对过的。

### 调度器：每秒扫一次，不是每个任务一个定时器

> "The scheduler checks every second for due tasks and enqueues them at low priority."

本扩展用**一个 1 秒的扫描循环**，到点的任务进入 pending 队列。

### 投递时机：turn 之间，不打断当前 turn

> "A scheduled prompt fires between your turns, not while Claude is mid-response.
> If Claude is busy when a task comes due, the prompt waits until the current turn ends."

- **定时 tick** 走 `deliverAs: "followUp"`（低优先级，等当前 turn 结束）
- **立即执行的那一次** 走 `deliverAs: "steer"`（对齐 CC 的 skill 在当前 turn 里
  "immediately execute the parsed prompt now"）
- 任务在 agent 忙时**不会发出去**，等 `agent_settled` 后再发

### 漏跑不积压

> "it fires once when Claude becomes idle, not once per missed interval."

agent 忙 10 分钟 + 1 分钟间隔 = **只发一条**，不是 10 条。

### 立即执行一次

> "Then immediately execute the parsed prompt now — don't wait for the first cron fire."

`/loop 5m xxx` 会**立刻**跑一次 `xxx`，之后才按 cron 走。

### 兜底心跳：预算只有 1 次

这是 CC 二进制里硬编码的（`x = 1`）：

- 某一轮结束时模型**没有**调 `schedule_wakeup` → arm **一次** 20 分钟的兜底心跳
- 兜底心跳那一轮模型**仍然没有**调度 → chain 结束（`keepalive budget exhausted`）
- 模型显式调用 `schedule_wakeup` 会**重置**这个预算

也就是说：**模型可以偷懒一轮，偷懒两轮 loop 就死。**

### 自选间隔的钳制与超龄

- `delaySeconds` 钳制到 `[60, 3600]`
- chain 超龄（默认 7 天）以 `aged out` 结束

### 任务过期与抖动

- 任务默认 **7 天**后自动过期（`PI_LOOP_MAX_AGE_DAYS`）
- 抖动默认 **0**（准点）。Claude Code 线上是 0.5（最多晚 30 分钟），
  用 `PI_LOOP_JITTER=0.5` 可以打开

### 恢复语义

- **固定间隔任务**：resume 时恢复并重新 arm（跟 CC 的 "restored on --resume" 一致）
- **自选间隔 chain**：**不恢复**——挂掉时 pending 的 wakeup 随进程一起没了，
  重启后会提示你重新 `/loop`

### tick 消息带来源标注

```
[loop tick #7 · scheduled by /loop, not typed by the user]
check the deploy and tell me what happened
```

防止模型把重复的 tick 误读成用户的新意图。

### 界面

Pi 默认会把 custom message 的 `customType` 当标题画成 `[pi-cc-loop-tick]`，一眼机器名。
本扩展注册了自己的 renderer，画成可折叠的卡片：

```
↻ loop tick #7 · 每10秒钟打印一次hello world        (Ctrl+O 展开)
```

展开后：

```
↻ loop tick #7 · 每10秒钟打印一次hello world

每10秒钟打印一次hello world
```

renderer 只影响**显示**，模型看到的内容不变（模型看到的仍然是带来源标注的完整
prompt）。

### 状态条（默认关闭）

**Claude Code 的主会话里没有任何常驻的 loop 状态显示** —— job id 只出现一次，在
`CronCreate` 的工具结果里；倒计时只出现在 `claude agents` 的后台会话列表里。
binary 里搜 `loopStatus` / `loop active` / `between iterations` 全是 0 命中。

所以这里**默认也不显示**。需要的话可以显式打开：

```
/loop widget on      # 输入框上方显示每条 loop
/loop widget off
```

```
loop oia0f8y4 · fixed */5 * * * * · next 03:30 PM (in 4m12s) · check the deploy
loop t1xqzdu4 · self-paced · next in 1m · 每10秒钟打印一次hello world
```

| 字段 | 含义 |
| --- | --- |
| `oia0f8y4` | loop 的 job id，用来精确停某一条：`/loop stop oia0f8y4` |
| `fixed` | 固定间隔，由 cron 表达式驱动 |
| `self-paced` | 自选间隔：模型每轮自己决定下次多久再来（对应 CC 的 "self-paced /loop"） |
| 末尾 | prompt 摘要，方便区分是哪条 loop |

也可以用环境变量 `PI_LOOP_WIDGET=1` 默认打开。

**不显示时，状态从哪看？** 跟 CC 一样，看工具结果：

```
Scheduled f01e57b3 (Every minute, next run 4:13 PM)
Cancel it with cron_delete { "id": "f01e57b3" }.
```

或者 `/loop status`（CC 没有这个命令，是这边加的便利功能，不产生界面元素）。

---

## 与 Claude Code 的差异

| | Claude Code | pi-cc-loop |
| --- | --- | --- |
| cron 表达式子集 | 5 字段，支持 `*` `*/N` `a-b` `a,b` | 相同（不支持 `L` `W` `?` 和 `MON` 这种名字） |
| 7m 这种不整除的间隔 | 舍入到最近的整除值（7m → 6m）并告知用户 | 相同（7m → 6m，附 `rounded to 6m` 说明） |
| 自然语言间隔（"每30秒"） | 靠模型读懂（skill 是 prompt） | 同样靠模型读懂（规则注入 guideline） |
| 秒级间隔 | 向上取整到 1 分钟并告知用户 | 相同 |
| 抖动 | 默认 0.5（最多晚 30 分钟） | 默认 0（准点），`PI_LOOP_JITTER` 可开 |
| 停止 loop | Esc / `CronDelete` | `/loop stop`（Pi 没有 Esc 绑定） |
| 状态显示 | 无常驻显示，job id 只在工具结果里 | 同上（状态条默认关闭，`/loop widget on` 可开） |
| 维护 prompt | 内置 | 内置，措辞按 Pi 改写 |
| loop.md 路径 | `.claude/loop.md` → `~/.claude/loop.md` | `.pi/loop.md` → `~/.pi/loop.md` |
| 持久化文件 | `.claude/scheduled_tasks.json` | `.pi/scheduled_tasks.json` |
| 事件驱动唤醒（Monitor） | 有 | 有，在 [`pi-cc-monitor`](../pi-cc-monitor/) 里 |

### 还没做的：Monitor 事件驱动

Claude Code 的自选间隔 `/loop` 有两个唤醒源：定时器（`ScheduleWakeup`）和
**事件**（`Monitor` 工具：后台脚本的 stdout 每行是一个事件，到达即唤醒 loop，
不等 deadline）。

**这一块已经补上了**，在单独的 [`pi-cc-monitor`](../pi-cc-monitor/) 包里：

```bash
pi install npm:pi-cc-monitor    # 或链接到 ~/.pi/agent/extensions/pi-cc-monitor/
```

装上之后，chain 的 guideline 会多告诉模型一句：

> Arm the `Monitor` tool with `loopPrompt` set to "<chain prompt>" so the event wakes
> this chain immediately instead of waiting for the next heartbeat.

模型照做之后：

1. monitor 事件到达 → pi-cc-monitor 发 `monitor:wake` 事件
2. pi-cc-loop 收到 → **顶掉**这条 chain 的兜底心跳，标记「模型该重新调度了」
3. agent 被唤醒处理事件 → 模型再调 `schedule_wakeup` 续上

没装 pi-cc-monitor 时，本扩展的行为一点不变（纯时间驱动），guideline 里也不会
提 Monitor 工具。

### 停止 loop 会连带停掉它的 Monitor

Claude Code 的要求是：*"call ScheduleWakeup with `stop: true` and **TaskStop any Monitor
you armed**"*。

这里通过 event bus 实现：

| 方向 | 通道 | 载荷 |
| --- | --- | --- |
| monitor → loop | `monitor:wake` | `{ monitorId, description, kind, cause, lines, eventCount, loopPrompt? }` |
| loop → monitor | `loop:stopped` | `{ prompt, reason }` |

所以：

- `/loop stop` → 停掉 chain + 停掉所有 `loopPrompt` 匹配该 chain 的 Monitor
- 模型调 `schedule_wakeup({stop:true})` → 同上
- chain 自然结束（keepalive 用完 / 超龄）→ 同上

**没有这一步的话，Monitor 会继续每 10 秒唤醒一次，模型被唤醒后按 guideline 调
`schedule_wakeup`，你刚停掉的 loop 就复活了。**

### 被停掉的 chain 不会被复活

pi-cc-loop 记住被停 chain 的 prompt。之后即使有残留事件把 agent 唤醒，
`schedule_wakeup` 也会被拒绝：

```
The /loop chain for "<prompt>" was stopped and must not be rescheduled.
```

用户重新 `/loop <同样的 prompt>` 会清掉这个标记。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_LOOP_MAX_AGE_DAYS` | `7` | 任务最长存活天数，`0` 表示不过期 |
| `PI_LOOP_KEEPALIVE_SECONDS` | `1200` | 兜底心跳延迟；`0` 表示禁用兜底（模型一轮不调度就直接结束） |
| `PI_LOOP_JITTER` | `0` | 抖动比例（0~1）。CC 线上默认是 0.5（最多晚 30 分钟），这里默认 0＝准点 |
| `PI_LOOP_SCAN_MS` | `1000` | 调度扫描间隔，测试时可调大 |

## 文件

```
index.ts      扩展主体：命令、工具、事件、持久化
cron.ts       5 字段 cron 解析 + 下次触发时间计算
schedule.ts   任务仓库 + 调度队列（pending / in-flight / 漏跑合并）
tests/        单元测试
```

## 测试

```bash
cd ~/workspace/pi_extensions/pi-cc-loop
node --test tests/*.test.mjs
```

（测试用 `jiti` 直接加载 TS，路径按本机 Pi 安装位置写死在 `tests/helpers.mjs` 里。）
