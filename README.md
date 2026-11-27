# pi-cc-loop

> 在 Pi 里复刻 Claude Code 的 `/loop`：固定间隔、自选间隔、兜底心跳和底部状态摘要。

Loop 只调度检查，业务后台任务交给外部 Runner，观察交给可选的 pi-cc-monitor。两包通过内部 v1 协议协作，也可单独安装。

## 安装

```bash
pi install npm:pi-cc-loop
```

安装后执行 `/reload`。本地开发时把仓库软链接到扩展目录即可：

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-loop
```

## 工作方式

`/loop` 和 CC 一样是一个**技能**，不是用代码直接排任务：你输入的内容会作为一条普通 user 消息进入对话，
模型自己解析间隔并调用工具完成。所以对话里始终能看到你要求了什么、模型做了什么。

给模型的规则（怎么建任务、自定步调怎么续期）以一条隐藏消息附在这一轮后面，不改 system prompt：
不支持对话中途 system 消息的 provider 会把 system prompt 整体重建，规则一来一去会让整段提示缓存失效。
固定间隔的每次触发不附加任何东西，信封里一句"它会自己触发下一次，取消用 cron_delete"就够了。

| 功能 | 说明 | 入口 |
| --- | --- | --- |
| 固定间隔 | 模型用 `cron_create` 建一个 cron（`5m` → `*/5 * * * *`），然后立即执行一次；触发时按"定时任务"呈现。不带 `/loop`、直接说"每分钟打印一次hello"也一样 | `/loop 5m <prompt>`、`/loop 每分钟 ...` |
| 自选间隔 | 运行一次后用 `schedule_wakeup` 决定下次延迟（60–3600s） | `/loop <prompt>` |
| loop.md | 请求本身没有任务时（裸 `/loop` 或只给间隔）由 `.pi/loop.md`（或 `~/.pi/loop.md`）提供，每次触发重读；没有时用内置维护 prompt | `/loop`、`/loop 15m` |
| 停止 / 查看 | 也走对话：模型用 `cron_list` / `cron_delete` 按 id 查看或停止固定／自定步调任务；停掉后再输入同一个 `/loop` 会重新开始 | `/loop stop`、`/loop status` |
| 回合中输入 | 模型正在回复时输入 `/loop ...`：底部提示"will start when the current turn ends"，当前回合结束后作为新的一轮开始（不会混进正在进行的回合） | 自动 |
| 漏跑合并 | agent 忙时到点只记一次 pending，空闲后发一条 | 自动 |
| 兜底心跳 | 模型忘记调度时 arm 一次 20 分钟心跳，预算 1 次 | 自动 |
| Esc 取消 | 打断自定步调 loop 的所属回合时取消它，包括首次已建观察但尚未 arm wakeup 的回合；无关回合、空闲时不受影响；固定间隔不受影响 | Esc |
| 错峰 | 周期任务按 id 固定延后最多半个周期（≤30 分钟），间隔本身不变；`:00`/`:30` 的一次性任务最多提前 90 秒 | 自动 |
| 过期 | 周期任务 7 天后最后执行一次再删除；一次性任务不过期 | 自动 |
| 次数上限 | `maxFires`，到顶自动删除 | `--max N` |
| 持久化 | `durable: true` 写入 `.pi/scheduled_tasks.json`，重启后继续；同一项目只由一个 Pi 会话执行 | `--durable` |
| 任务面板 | 一个原生的 TUI 浮层，统一查看本会话的 Loop 和 Monitor 任务；本地命令，不进对话 | `/tasks`（重名时改用 `/cc-tasks`，二选一） |
| 底部摘要 | Pi 底部状态栏一行：`2 loops · next 3m`，无任务时不占位 | `/loop_settings footer on\|off` |
| 界面设置 | Loop 独立设置面板，本地命令，不进对话 | `/loop_settings` |

## 命令

```text
/loop <间隔> <prompt>     固定间隔重复（模型用 cron_create）
/loop <prompt>            自选间隔（模型用 schedule_wakeup）
/loop [间隔]              跑 loop.md，没有就跑内置维护 prompt
/loop status              列出当前任务
/loop stop [id]           停止一个或全部
/loop help                本地：帮助
/loop_settings            本地：Loop 设置面板（见下）
/tasks                    本地：任务面板（All / Monitor / Loop），名称空闲时注册
/cc-tasks                 本地：/tasks 已占用时改用；不与 /tasks 同时注册
```

前五个会作为普通 user 消息进入对话（内容就是你输入的那行），模型再按技能说明调用工具；`/loop help`、`/loop_settings` 和选中的任务面板入口（`/tasks` 或 `/cc-tasks`）只改界面，不进对话。
旧的 `/loop footer`、`/loop settings` 会提示改用 `/loop_settings`，不会当成 loop 请求。

间隔写法没有约束，模型自己解析：`30s`、`5m`、`2h`、`1d`、`check the deploy every 20m`、
`每2分钟输出一次`、`每分钟打印一次hi` 都可以。小于一分钟会向上取整到每分钟。

可以在请求里加 `--durable`（写入 `.pi/scheduled_tasks.json`，重启后继续）和 `--max N`（触发 N 次后自动删除）。

### 外部任务与观察

业务后台任务通过执行机器上已有的 Runner 原生 CLI 提交。用户／项目指定优先，否则检查可用工具，优先考虑 tmux；没有合适工具时询问，不自动安装或退回 Monitor 执行。

需要等任务结果时，先查 `monitor_list` 是否已有观察，再连接原始来源：

```json
{"source":{"kind":"job","manifest":"runs/train-01/job.json"},"description":"training result","persistent":true,"loopPrompt":"check the existing training result"}
```

文件／WebSocket 用 events，外部任务有效终态用 completion。停止 Loop、Esc 中断所属回合、观察器超时或断线都不取消独立 Runner 的任务；需要取消训练时明确调用 Runner 的取消命令。重新连接使用原 jobId/runId，不能重复提交。

Loop 的 durable 设置保存的是调度 prompt，不是执行进程。它不托管训练，也不让 Pi 退出期间继续运行模型。

两包新代码联合加载时，新 `/loop` 回合先取得内部活动身份，再建立观察或 wakeup，不新增工具参数或提前安排任务。首次 wakeup 沿用该身份；后续 tick、Monitor 事件、续期和停止按身份关联，不再通过任务文字接管其他活动。两次显式启动的同名自定步调 Loop 保持独立，首次 arm 前取消也只结束当前活动。已取消身份的旧事件不能复活活动；旧无身份消息只允许唯一的 prompt 兼容匹配，歧义时拒绝猜测。新版本无归属的观察通知明确标记为无归属，不再冒充旧消息；停止 outcome 也是事实，不会通过同名文字借用其他活动。固定 cron 的 Esc 规则和观察恢复策略不变。

普通对话里先绑定观察再安排自定步调 wakeup 时，两处使用同一个任务 prompt。该临时身份只属于这一个任务；明确指向已有 Loop 的绑定仍按各自的活动处理。若要开始另一条新 Loop，单独启动；同轮创建无关的固定 cron 不会解除已有绑定。

Loop 通过内部 v1 能力握手识别观察型 Monitor，不根据同名工具推断。未确认能力时不向模型添加绑定指引；旧的无身份历史通知仍可按唯一 prompt 识别。建议联合升级两包。

### loop.md 与上下文

裸 `/loop` 每次触发重读任务文件；全文在首次投递、文件变化或上下文失效后提供，平时只发短提醒。`/tree` 和压缩会使旧正文不再可靠：如果启动前的自动压缩发生在提醒生成之后，扩展在 `before_agent_start` 用隐藏的模型可见消息补全文，当前回合不会只拿到“找不到则 no-op”。有效链的 Monitor 唤醒也走相同补送，不改变系统提示前缀、不另开回合。

错峰、过期、兜底心跳与无文件时的维护任务属于 `cc-loop-policy.ts` 的兼容预设，不是调度器的隐含行为。当前扩展仍选这个预设，裸 `/loop` 和 `PI_LOOP_*` 环境变量的行为未改。

补送携带当时单次读取的快照令牌，等 `message_end` 确认进入运行上下文后才记为已提供；不会在确认时重新读文件。这样准备失败仍可重发，准备与确认之间的文件编辑也会在下次迭代生效；成功补送后，持续的 Monitor 唤醒不会反复追加同一份全文。树切换或压缩会使未确认的旧令牌失效。

### 持久任务与子代理

同一项目的持久任务只由一个调度器实例执行。锁用 PID、主机名和每个实例独有的令牌识别归属，
所以主会话与 subagent 即使在同一个 Pi 进程里，也不会同时接管同一批任务；其他会话仍能添加、查看或取消任务。
派发持久任务前会重新核验并续期锁，失去归属的实例停止执行已载入的持久任务，不影响它的会话级任务。单条任务写入不会冒充全量同步；取消后的迟到执行只更新仍存在的任务，不会把已删除的计划重新插入。接管后会保存实际已 arm 的下次时间，其他会话的 foreign 视图也能看到同一时间。

`/reload` 先由旧实例释放锁，新实例再获取；持锁进程退出或心跳超过 60 秒未更新时，其他实例可以接管。
旧实例不会续写或删除新实例的锁。旧版没有实例令牌的锁仍被尊重，释放或过期后才换成新版格式；任务文件无需迁移。

## 任务面板 `/tasks`

启动时二选一注册：`/tasks` 未被占用就只注册 `/tasks`；已被占用就只注册 `/cc-tasks`（连字符），不再注册旧的 `/cc_tasks`（下划线）。选中的入口打开原生的 Pi 浮层（`ctx.ui.custom(..., { overlay: true })`），不是编辑器里的快捷键，也不经过模型：
打开、刷新、关闭都不会发消息、不会开新一轮、不会改工具集，模型正在回复时也可以打开。RPC 模式通过 `ctx.ui.notify` 输出一段文字摘要；print/JSON 模式是安全 no-op（不调用 TUI 方法，也不输出摘要）。

```text
╭──────────────────────────────────────────────────────────────────╮
│ Tasks                                                  Esc close │
│ All 3  /  Monitor 2  /  Loop 1                                   │
├──────────────────────────────────────────────────────────────────┤
│ ▸ M running deploy errors · 4 ev · 1m 12s                        │
│   M exited  health check · 2 ev · 5s                             │
│   L scheduled watch CI · next 2m · 3 fires                       │
├──────────────────────────────────────────────────────────────────┤
│ Tab switch · ↑↓ select · Enter detail · x stop · Esc close       │
╰──────────────────────────────────────────────────────────────────╯
```

- **范围**：只列本会话的任务；本项目的 durable 任务按锁的归属显示，别的会话执行的任务标成 foreign，不会说成“正在这里运行”。不做跨会话的全局面板。
- **Tab / Shift+Tab**：两个及以上 provider 时显示 All / Monitor / Loop 等页面；只有一个 provider 时只显示该 provider，不重复显示 All，也不显示 Tab 切换提示。上下键走 Pi 的 `tui.select.up/down` 命名动作，所以会跟随你的 keybindings；PgUp/PgDn 翻页。选中项用 `provider + id` 记录，刷新或增删任务后不会跳到别的任务上。
- **排序**：按创建时间倒序，最新任务在最上方；All 页按同一时间顺序混排 Monitor / Loop，不按 provider 分块。相同时间保持稳定顺序，状态变化不改变排序。任务之间没有父子关系，也不从标题推断；新 Monitor 来源是独立观察器。
- **鼠标与滚动**：Pi fullscreen 模式下，单击页签切换列表，单击任务选中、双击打开详情；标题栏的返回/关闭和底部的 Detail / Stop / Cancel 都可点击。滚轮 / 触控板滚动列表、详情和长停止说明，右侧滚动条支持点击与拖动，底部显示可见范围；普通详情文本仍可拖拽选中。滚动到边界不会带动后方对话，普通 scrollback 模式保留完整键盘操作。
- **Enter**：详情。Esc 先回列表，再按一次才关面板；关面板只关 UI，不取消任何任务，也不会把 Esc 传给 app.interrupt。
- **Loop 详情**：cron 还是自定步调、实际的下次时间（`nextFireAt` / `scheduledFor`，已含错峰，不是从 `cron_list` 文本里猜的）、模型给的 reason、触发次数、是否 pending 等待 agent 空闲、是否 active / 等待重新调度、durable 归属；还会区分 `--durable` 里别的会话执行或从别的目录复制来的任务。
- **Monitor 详情**：分别显示观察状态、文件／任务状态／WebSocket 来源、外部 jobId/runId 与结果、观察期限和绑定 Loop。stdout/stderr 是可回收观察副本，详情只读有界尾部并净化终端字符；源读取错误不是任务失败，读取详情不产生新事件。
- **刷新**：任务变化会通知面板，但会按 250ms 合并；时间显示每秒走一次。不会每来一行 stdout 就重绘。窗口窄、调整终端大小、宽字符（中文/emoji）、主题切换都有处理，正文高度有上限并可滚动。
- **`x` 停止**：先本地确认（`y` / `n`），不经过模型。它复用各包自己的停止逻辑：
  - Monitor 走 `endMonitor`：只关闭读取句柄、观察连接和副本，并发观察停止通知；不调用 Runner 取消命令，不向业务任务发送信号。
  - 自定步调 loop 走 `retireChain`：按活动身份结束并通过 `loop:stopped` 停止绑定的 Monitor；已停止 prompt 的记忆仅作为旧调用的兼容防护，不按同名文字取消其他已识别活动。
  - cron / durable 走 `removeJob` / durable store 删除；别的会话执行的 durable 任务只删存储里的那一条。
  - **停止的是计划，不是主 agent**：不会 abort 当前回复，也不会结束正在运行的 turn；要中断模型请照常按 Esc 或用 Pi 的 abort。
- 已结束的 Monitor 记录在终态通知投递且资源释放后保留最近 50 条，停止动作禁用；活跃、待通知或清理中的观察记录不会因数量上限被淘汰。v1 不做暂停/恢复、不改 cron、不做每个 loop 的独立 transcript，也不保留已结束 loop 的历史。

两个包共用一套命令注册：只装 loop 或只装 monitor 都能使用；两个都装时也只注册一个面板入口。所有 `session_start` 处理完成、构建补全列表之前，会检查当时已加载的扩展命令和 prompt 模板（包括已重名的 `/tasks:1` 等入口）：名称空闲时只注册 `/tasks`；已占用时不抢占、不新增 `/tasks:1`，只注册 `/cc-tasks`。无法安全查询命令列表的旧版宿主也只提供 `/cc-tasks`。同一运行时不因再次资源发现而切换或补注册别名；`/reload` 会为新的扩展实例重新检查。检查不覆盖其他插件之后动态新增的命令。任务面板入口不是 `/loop_settings`（Loop 设置面板），也不改变 `/loop` 的语义。

## 工具

| 工具 | 界面显示 | 说明 |
| --- | --- | --- |
| `cron_create` | `CronCreate` | 5 段 cron（本地时区）+ prompt；`recurring` 默认 `true`，`false` 为一次性；可选 `durable`、`maxFires` |
| `cron_delete` | `CronDelete` | 按 id 取消；也能结束自定步调 loop |
| `cron_list` | `CronList` | 列出任务和实际的下次运行时间（已含错峰） |
| `schedule_wakeup` | `ScheduleWakeup` | 自定步调：`delaySeconds`（限制在 60–3600）、`reason`（必填，显示在触发块表头）、`prompt`；`stop: true` 结束 |

四个工具都声明了 `outputSchema`。三个 cron 工具保持可从 codemode 调用：`tools.cron_create(...)`、`tools.cron_list()` 返回结构化结果（`{ id, nextFireAt, … }`、`{ jobs: [...] }`），可以在脚本中批量查询/取消。

`schedule_wakeup` 是 **model-only 的回合控制工具**：仍直接向模型声明，但不能通过 codemode 或其他工具间接调用。新建/续期必须是当前 assistant 响应中的唯一工具调用；先完成 Monitor 等操作并向用户更新，再单独调用。运行时无法确认独立调用、或发现同批有其他调用时，会拒绝且不创建/修改 wakeup。`stop: true` 不强制结束回合，仍可向用户说明停止结果；固定 cron tick 的重复 wakeup 仍保持无操作。

## 渲染

定时触发只显示任务本身，给模型看的信封不上屏：

```text
✻ Running scheduled task · Every minute · 9:52pm · ctrl+o to show more

✻ Loop #3 · watching CI run · 9:53pm · self-paced · ctrl+o to show more
```

固定间隔按“定时任务”呈现；只有自选间隔叫 loop，表头带上模型给的 `reason`。折叠时只有一行，任务正文在展开里。
展开是工具卡底色的段落树：`Schedule`（cron 节奏）、`Late`、`Reason`、`Job`（任务 id 与来源）、`Prompt`。

Loop 结束时给同一套卡片标题，不再露出 Pi 的原始消息类型（以前会显示 `[pi-cc-loop-outcome]`）：

```text
■ Loop Stopped · 5 · 9:54pm · not rescheduled · ctrl+o to show more
⚠ Loop Expired · 5 · 9:54pm · schedule expired
⚠ Loop Tick Failed · 5 · 9:54pm · stays due
```

展开里是 `Status`（给模型的说明）、`Job`、`Prompt`。停止、到期、投递失败都请求一次模型回复；Esc 不会重放已被打断的回复。忙碌时 outcome 保存在独立 outbox，等响应／整个工具批次结束后追加并至多请求一次续接；普通 Esc 清队列不删除这些事实，aborted settlement 只保存、不重启回复。Esc 自身取消所属链仍保持静默。
天数上限与调度器的到期是同一个事实，两处都叫 `Loop Expired`。投递失败只影响这一次触发（`stays due` 或 `this tick skipped`），所以是警告色调、不带结束标记。

按宿主屏幕模式给不同的展开入口，用的都是 Pi 原生接口：fullscreen 提示 `click to show more` 并支持左键点击展开/收起
（`Component.handleMouse`，指针停在提示上时提亮）；regular 提示 `ctrl+o to show more`（`options.keyHint("app.tools.expand", …)`），因为主屏不投递鼠标事件。
Ctrl+O 走宿主自己的 `CustomMessageComponent.setExpanded`，两种模式都有效。`missed` 列表用警告色和 `⚠`。
`compactMessages` 关闭时回到旧的带底色卡片。

## /loop_settings

本包独立提供 `/loop_settings`，只包含 Loop 的消息样式和底部摘要。TUI 中打开单页设置面板，上下键选择、Enter/空格切换、Esc 关闭；改动立即保存，不进入模型对话。RPC 中不带参数时输出当前设置，也可以使用 `/loop_settings messages on|off`、`/loop_settings footer on|off`。

默认配置文件是 `~/.pi/agent/pi-cc-loop.json`，跟随 `PI_CODING_AGENT_DIR`：

```jsonc
{
  "compactMessages": true,   // Loop 触发消息用紧凑样式；false 为旧卡片
  "footer": true             // Loop 底部摘要
}
```

Loop 和 Monitor 各自保存设置，关闭本包的 footer 或修改消息样式不会改变 Monitor。`config.ts`、`settings.ts` 只维护本包的选项，不再同步其他包的设置定义。

兼容旧配置：新文件不存在时读取旧 `pi-cc.json` 中本包的有效字段；首次保存把这些选择带入新文件。已有新文件不会被旧配置覆盖，旧文件不会被修改或删除。`PI_CC_CONFIG_FILE` 可显式指定配置路径，此时不回读旧文件。

环境变量 `PI_CC_FOOTER`、`PI_CC_COMPACT_MESSAGES` 仍优先于文件，且不会写进文件；设置了变量的选项在面板中锁定，文字命令仍可保存以后使用的值。旧变量名保留兼容：全局设置这两个变量仍会同时覆盖 Loop 和 Monitor，但两个包的文件和命令彼此独立。

本包不再注册共享的 `/pi_cc`；旧脚本请改用 `/loop_settings`。Pi 内置的 `/settings` 不受影响。

## 临时文件回收

普通 Loop 任务状态沿用 Pi 会话记录，不额外生成日志或执行脚本。持久化任务仍存于 `.pi/scheduled_tasks.json`，`loop.md` 只读取；这些用户数据不参与自动清理。

设置、持久化任务和调度锁的原子写入改用目标文件旁的私有暂存目录：`<文件名>.pi-cc-loop-tmp-*`。归属标记记录目标路径、主机、PID 和结束状态，正常写完立即回收。会话启动及每 **30 分钟**检查本包配置文件、任务文件和调度锁对应的暂存空间；只回收最后活动超过 **24 小时**、且已明确关闭或所属进程确认退出的自有暂存目录。清理异常不会让已保存的设置或正常调度失败，关闭／重载会撤销检查定时器。

不删除目标 JSON、活跃写锁、调度锁、`loop.md` 或 Pi 会话；不清理其他系统用户的目录、不跟随符号链接，也不根据名字猜测旧版无标记的松散 `*.tmp` 文件可以删除。既有写锁／调度锁仍走各自原来的释放和陈旧接管规则。

## 底部摘要

`ctx.ui.setStatus("loop", …)` 是 Pi 核心 API，不依赖任何其他扩展：

| 场景 | 显示 |
| --- | --- |
| 没有任务 | 不设置状态，footer 不会被多占一行 |
| 有任务 | `3 loops · next 4m`（数量 + 最近一次触发） |
| 到点但等待 agent 空闲 | `1 loop · waiting`，不再显示成即将触发 |
| 自定步调回合进行中、尚未重调度 | `1 loop · active`；若另有已排定任务，倒计时只计算那些任务 |
| 一分钟内 | `1 loop · next <1m` |
| 超过一小时 | `1 loop · next 2h 15m` |

- 倒计时取整到分钟，配合"文本相同就不调用"的去重，最多每分钟重绘一次（Pi 每次 `setStatus` 都会触发重绘）
- 装了 `pi-cc-extensions`：这一行会作为它的一个 chip 出现在第 2 行，可在它的配置面板里移动或隐藏；它会把 ANSI 去掉，所以这里只用纯文本
- 没装 `pi-cc-extensions`：Pi 内置 footer 会把它和其他扩展的状态拼成一行，加在用量行下面，只在有任务时出现
- 装了 `pi-cc-monitor`：运行中的 monitor 另有一项 `2 monitors`，两个包各用自己的设置开关

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_LOOP_MAX_AGE_DAYS` | `7` | 周期任务最长存活天数，`0` 不过期 |
| `PI_LOOP_KEEPALIVE_SECONDS` | `1200` | 兜底心跳；`0` 禁用 |
| `PI_LOOP_JITTER` | `0.5` | 周期任务最多延后的周期比例；`0` 关闭错峰 |
| `PI_LOOP_SCAN_MS` | `1000` | 调度扫描间隔 |
| `PI_LOOP_DURABLE_SYNC_MS` | `5000` | 持久化任务文件的同步间隔 |
| `PI_CC_FOOTER` | — | `0` / `1`，覆盖设置文件里的 `footer` |
| `PI_CC_COMPACT_MESSAGES` | — | `0` / `1`，覆盖设置文件里的 `compactMessages` |
| `PI_CC_CONFIG_FILE` | `~/.pi/agent/pi-cc-loop.json` | 显式指定配置文件；不设时跟随 `PI_CODING_AGENT_DIR`，新文件缺失时兼容旧配置 |

## 兼容性

- Node.js `>=22.19.0`
- Pi 1.6.0、1.6.1（本轮修复与回归验收通过）；Pi 1.5.2 及更早版本本轮未重新验收
- `pi-cc-monitor` 可选：新指引使用观察型 source 接口；自定步调 loop 等待外部事件时观察已有来源，Loop 结束只停止观察。两者通过 `pi.events` 通信，不共享设置或 Runner 执行层。
- 与 `pi-cc-extensions` 共存。本扩展不写其他插件的配置文件；旧版本在 `pi-cc-extensions.json` 里加过的
  `cron_create`、`cron_delete`、`cron_list`、`schedule_wakeup` 这几条 `excludeRenderers` 可以删掉

## 本地开发

```bash
node --test tests/*.test.mjs
npm run typecheck
node scripts/cache-check.mjs --dry-run  # 离线验证观察夹具，不启动 Pi／模型
node scripts/cache-check.mjs            # 显式在线缓存测量，消耗 provider 配额
```

Loop/Monitor 的 `render.ts`、`tasks.ts`、`log-tail.ts`、`observation-link.ts` 和 `terminal-outbox.ts` 以本仓库为维护源。修改后运行 `node scripts/sync-shared.mjs` 同步到 Monitor；`--check` 和两包的 `tests/shared.test.mjs` 检查一致性。两包无运行时依赖，终态队列各自持有，只确认交给 Pi，不承诺跨重启或模型已读。各包设置和视图独立维护。

类型检查使用本地 TypeScript 开发依赖，并自动定位本地 peer dependencies 或当前安装的 Pi release；`tsconfig.json` 不再包含个人目录或旧 release 的绝对路径。可用 `PI_AGENT_DIR` 选择隔离的 Pi 安装，用 `PI_TYPESCRIPT_PATH` 指向已有的 `typescript/lib/typescript.js`。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息），扩展只能往对话末尾追加：

- **不改 system prompt**：每轮需要的规则作为隐藏消息附在这一轮后面（`before_agent_start` 返回 `message`），不写 `promptGuidelines`，不返回 `systemPrompt`。
- **不动工具集**：工具在加载时一次注册，描述是固定文本；不调用 `setActiveTools`，会话中途不改描述。
- **不改历史**：不注册 `context` / `context_with_system` / `before_provider_request`。

`tests/cache.test.mjs` 守住这三条。`scripts/cache-check.mjs` 用真实 provider 依次走一遍固定间隔 `/loop`、触发、普通对话、`/loop stop`、Monitor 事件、自定步调 `/loop` 和它的触发，逐个请求看缓存读取量：
读到的明显少于上一个请求发出的内容就报 MISS（退出码 1）。provider 偶尔会自己丢缓存，同一步骤重跑仍然 MISS 才是扩展的问题。
默认模型名为 `opencode-go/beam-free`，实际可用性／计费以 provider 为准；`--model` 可替换，在线测量会打印报告费用。`--dry-run` 只校验夹具与协议，不启动 Pi、不读取认证、不访问网络，不代表实测缓存命中。Monitor 场景改为观察探针驱动器在 Pi 外写入的两条日志和有效终态，不让模型启动后台命令。

## 与 Claude Code 的差异

行为对齐 Claude Code 2.1.308 的 `/loop`，用 Pi 扩展 API 实现。有意不同的地方：

- Esc 只取消被打断回合所属的自定步调 loop；CC 按 Esc（包括空闲时、打断无关回合时）会取消所有自定步调 loop。其他情况用 `/loop stop`。
- 固定间隔的触发里调用 `schedule_wakeup` 会被当作空操作并返回说明，防止同一个任务又被自定步调重复调度；CC 没有这条硬规则。
- 不带 `/loop` 的请求（比如"每分钟打印一次hello"）也会在建好任务后立即做一次。CC 靠模型自己调用 loop 技能做到（`CronCreate` 在 CC 里是延迟加载的工具，模型会先走技能）；本包默认直接声明 cron 工具，这里改为在 `cron_create` 的结果里加一句提示，只在普通对话里建周期任务时出现。
- 底部摘要和 `maxFires` 次数上限是额外加的；CC 主会话不显示 loop 状态，也没有次数上限。
- 自定步调 loop 结束（stop、Esc、`cron_delete`、兜底心跳用完）时，只静默停止绑定的 Monitor 观察；独立 Runner 的任务不被取消或重提交。CC 的后台会话／Supervisor 不由本扩展复制。
- Monitor 事件不会取消待触发的 wakeup，它始终是兜底心跳（与 CC 一致）。
- 没有做 CC 的 `noop` 折叠、触发时"不是用户实时输入"的安全提示、间隔边界提示和云端调度。
- 没有做 CC 针对 5 分钟提示缓存的两处调整（`*/5` 每次提前 15 秒、接近 300 秒的唤醒往回拉）。在 5 分钟缓存的 provider 上（比如 Anthropic 默认），`*/5` 的触发和 300 秒左右的唤醒可能刚好错过缓存。

## 许可证

MIT
