# pi-cc-loop

> 在 Pi 里复刻 Claude Code 的 `/loop`：固定间隔、自选间隔、兜底心跳和底部状态摘要。

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
| 停止 / 查看 | 也走对话：模型用 `cron_list` / `cron_delete`（自选间隔用 `schedule_wakeup` + `stop: true`）；停掉后再输入同一个 `/loop` 会重新开始 | `/loop stop`、`/loop status` |
| 回合中输入 | 模型正在回复时输入 `/loop ...`：底部提示"will start when the current turn ends"，当前回合结束后作为新的一轮开始（不会混进正在进行的回合） | 自动 |
| 漏跑合并 | agent 忙时到点只记一次 pending，空闲后发一条 | 自动 |
| 兜底心跳 | 模型忘记调度时 arm 一次 20 分钟心跳，预算 1 次 | 自动 |
| Esc 取消 | 打断属于某个自定步调 loop 的回合（它的 tick、它的 Monitor 唤醒的回合）时取消该 loop；无关回合、空闲时不受影响；固定间隔不受影响 | Esc |
| 错峰 | 周期任务按 id 固定延后最多半个周期（≤30 分钟），间隔本身不变；`:00`/`:30` 的一次性任务最多提前 90 秒 | 自动 |
| 过期 | 周期任务 7 天后最后执行一次再删除；一次性任务不过期 | 自动 |
| 次数上限 | `maxFires`，到顶自动删除 | `--max N` |
| 持久化 | `durable: true` 写入 `.pi/scheduled_tasks.json`，重启后继续；同一项目只由一个 Pi 会话执行 | `--durable` |
| 任务面板 | 一个原生的 TUI 浮层，统一查看本会话的 Loop 和 Monitor 任务；本地命令，不进对话 | `/tasks`（重名时改用 `/cc-tasks`，二选一） |
| 底部摘要 | Pi 底部状态栏一行：`2 loops · next 3m`，无任务时不占位 | `/pi_cc footer on\|off` |
| 界面设置 | 按插件分页的设置面板，本地命令，不进对话 | `/pi_cc` |

## 命令

```text
/loop <间隔> <prompt>     固定间隔重复（模型用 cron_create）
/loop <prompt>            自选间隔（模型用 schedule_wakeup）
/loop [间隔]              跑 loop.md，没有就跑内置维护 prompt
/loop status              列出当前任务
/loop stop [id]           停止一个或全部
/loop help                本地：帮助
/pi_cc                    本地：pi-cc 设置面板（见下）
/tasks                    本地：任务面板（All / Monitor / Loop），名称空闲时注册
/cc-tasks                 本地：/tasks 已占用时改用；不与 /tasks 同时注册
```

前五个会作为普通 user 消息进入对话（内容就是你输入的那行），模型再按技能说明调用工具；`/loop help`、`/pi_cc` 和选中的任务面板入口（`/tasks` 或 `/cc-tasks`）只改界面，不进对话。
旧的 `/loop footer`、`/loop settings` 会提示改用 `/pi_cc`，不会当成 loop 请求。

间隔写法没有约束，模型自己解析：`30s`、`5m`、`2h`、`1d`、`check the deploy every 20m`、
`每2分钟输出一次`、`每分钟打印一次hi` 都可以。小于一分钟会向上取整到每分钟。

可以在请求里加 `--durable`（写入 `.pi/scheduled_tasks.json`，重启后继续）和 `--max N`（触发 N 次后自动删除）。

### 持久任务与子代理

同一项目的持久任务只由一个调度器实例执行。锁用 PID、主机名和每个实例独有的令牌识别归属，
所以主会话与 subagent 即使在同一个 Pi 进程里，也不会同时接管同一批任务；其他会话仍能添加、查看或取消任务。
派发持久任务前会重新核验并续期锁，失去归属的实例停止执行已载入的持久任务，不影响它的会话级任务。

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
- **排序**：按创建时间倒序，最新任务在最上方；All 页按同一时间顺序混排 Monitor / Loop，不再按 provider 分块。source 与 subscription 仍成组、父项在前，同级订阅也按创建时间倒序；相同时间保持稳定顺序，状态变化不改变排序。
- **鼠标与滚动**：Pi fullscreen 模式下，单击页签切换列表，单击任务选中、双击打开详情；标题栏的返回/关闭和底部的 Detail / Stop / Cancel 都可点击。滚轮 / 触控板滚动列表、详情和长停止说明，右侧滚动条支持点击与拖动，底部显示可见范围；普通详情文本仍可拖拽选中。滚动到边界不会带动后方对话，普通 scrollback 模式保留完整键盘操作。
- **分组折叠**：source 旁的 `▾` / `▸` 可点击收起或展开其 subscription；选中父任务时也可用 Left / Right 折叠或展开。收起只影响显示，不会停止任务，All 与 provider 页共用同一分组关系。
- **Enter**：详情。Esc 先回列表，再按一次才关面板；关面板只关 UI，不取消任何任务，也不会把 Esc 传给 app.interrupt。
- **Loop 详情**：cron 还是自定步调、实际的下次时间（`nextFireAt` / `scheduledFor`，已含错峰，不是从 `cron_list` 文本里猜的）、模型给的 reason、触发次数、是否 pending 等待 agent 空闲、是否 active / 等待重新调度、durable 归属；还会区分 `--durable` 里别的会话执行或从别的目录复制来的任务。
- **Monitor 详情**：状态、命令或 WebSocket、事件数与限流丢弃数、已运行时间、超时/常驻、退出码、绑定的 loop；stdout/stderr 只读**有上限的尾部**（约最后 8KB / 60 行），ANSI 和控制字符会被剥掉。日志不存在或读不了只显示说明，不影响 monitor；读日志也不会喂给 Monitor 的事件流。
- **刷新**：任务变化会通知面板，但会按 250ms 合并；时间显示每秒走一次。不会每来一行 stdout 就重绘。窗口窄、调整终端大小、宽字符（中文/emoji）、主题切换都有处理，正文高度有上限并可滚动。
- **`x` 停止**：先本地确认（`y` / `n`），不经过模型。它复用各包自己的停止逻辑：
  - Monitor 走 `endMonitor`：结束进程树或关闭 socket，并照常发一条 `[Monitor stopped]`。
  - 自定步调 loop 走 `retireChain`：记下已停止的 prompt 防止迟到的 `schedule_wakeup` 复活，并通过 `loop:stopped` 连带停止绑定的 Monitor。
  - cron / durable 走 `removeJob` / durable store 删除；别的会话执行的 durable 任务只删存储里的那一条。
  - **停止的是计划，不是主 agent**：不会 abort 当前回复，也不会结束正在运行的 turn；要中断模型请照常按 Esc 或用 Pi 的 abort。
- 已结束的 Monitor 记录在终态通知投递且资源释放后保留最近 50 条，停止动作禁用；活跃、待通知、清理中或仍被订阅引用的记录不会因数量上限被淘汰。v1 不做暂停/恢复、不改 cron、不做每个 loop 的独立 transcript，也不保留已结束 loop 的历史。

两个包共用一套命令注册：只装 loop 或只装 monitor 都能使用；两个都装时也只注册一个面板入口。所有 `session_start` 处理完成、构建补全列表之前，会检查当时已加载的扩展命令和 prompt 模板（包括已重名的 `/tasks:1` 等入口）：名称空闲时只注册 `/tasks`；已占用时不抢占、不新增 `/tasks:1`，只注册 `/cc-tasks`。无法安全查询命令列表的旧版宿主也只提供 `/cc-tasks`。同一运行时不因再次资源发现而切换或补注册别名；`/reload` 会为新的扩展实例重新检查。检查不覆盖其他插件之后动态新增的命令。任务面板入口不是 `/pi_cc`（设置面板），也不改变 `/loop` 的语义。

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
✻ Running scheduled task · 9:52pm
   print hi

✻ loop #3 · 9:53pm · watching CI run
   check the deploy
```

固定间隔按"定时任务"呈现；只有自选间隔叫 loop，表头带上模型给的 `reason`。折叠时正文最多 3 行，
Ctrl+O 展开后多一行元信息（任务 id、节奏）。`compactMessages` 关闭时回到旧的带底色卡片。

## 设置

四个 pi-cc 扩展共用 Pi 配置目录下的 `pi-cc.json`（默认 `~/.pi/agent/pi-cc.json`，跟随 `PI_CODING_AGENT_DIR`），文件不存在时用默认值：

```jsonc
{
  "compactMessages": true,   // 触发块和 Monitor 事件用上面的样式；false 为旧的带底色卡片
  "footer": true,            // 底部摘要：Loop 和 Monitor 的数量
  "draft": true,             // pi-cc-plugins：Ctrl+C 找回
  "turnSummary": true,       // pi-cc-plugins：回合摘要一行
  "ccKeys": true,            // pi-cc-plugins：Enter 排队、↑ 取回待发消息
  "compaction": true,        // pi-cc-compaction：Claude Code 的压缩
  "idleCompaction": true     // pi-cc-compaction：空闲压缩
}
```

draft、turnSummary、ccKeys 只被 pi-cc-plugins 读取，compaction、idleCompaction 只被 pi-cc-compaction 读取。面板和非 TUI 摘要只显示已加载包的页面；未安装包的值仍原样保留，文字命令仍可用来预配置。

在 TUI 里输入 `/pi_cc` 会打开设置面板，和 pi-cc-extensions 的 `/ccstyle` 一样按页组织，每个插件一页：
**Loop & Monitor**（消息样式、底部摘要，两个包共用）、**Plugins**（pi-cc-plugins）、**Compact**（pi-cc-compaction）。
有多个页面时用 Tab / Shift+Tab 切换，上下键选择，Enter/空格切换，Esc 关闭；改动立即保存，所有 pi-cc 扩展同时生效。
Pi 的 `/settings` 不接受扩展加项，所以 pi-cc 的设置放在 `/pi_cc` 下。

`/pi_cc` 由四个 pi-cc 包（loop、monitor、plugins、compaction）共同提供：装了其中任意一个，命令就在；装了多个，也只有一个 `/pi_cc`
（Pi 会把不同扩展的同名命令变成 `/pi_cc:1`、`/pi_cc:2`，所以由最先加载的包认领注册，会话结束时释放，`/reload` 会重新认领）。

```text
──────────────────────────────────────────────────────────────────────
Loop & Monitor / Plugins / Compact             ~/.pi/agent/pi-cc.json
──────────────────────────────────────────────────────────────────────
→ Message style    compact
  Footer summary   on

  How scheduled fires and Monitor events are drawn. compact: ✻ header
  and indented body; card: the old padded card.
──────────────────────────────────────────────────────────────────────
  Enter/Space to change · Tab/Shift+Tab to switch pages · Esc to close
──────────────────────────────────────────────────────────────────────
```

也可以用文字命令：`/pi_cc messages on|off`、`/pi_cc footer on|off`，适合脚本和 RPC；
非 TUI 模式下，不带参数的 `/pi_cc` 按页输出当前设置。命令只写改动的那一项，文件里的其他内容原样保留。

环境变量 `PI_CC_FOOTER`、`PI_CC_COMPACT_MESSAGES`（pi-cc-plugins 的三项是 `PI_CC_DRAFT`、`PI_CC_TURN_SUMMARY`、`PI_CC_KEYS`，pi-cc-compaction 的两项是 `PI_CC_COMPACTION`、`PI_CC_IDLE_COMPACTION`）优先于文件，但不会被写进文件。设着的时候，面板里这一项显示实际生效的值、不能切换，
说明里写出是哪个变量；文字输出会在对应项后面标出来（如 `hidden (PI_CC_FOOTER=0)`）；用文字命令切换会写进文件，但提示会说明变量还在覆盖它。

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
- 装了 `pi-cc-monitor`：运行中的 monitor 另有一项 `2 monitors`，和这一行用同一个开关

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
| `PI_CC_CONFIG_FILE` | `~/.pi/agent/pi-cc.json` | 设置文件路径；不设时在 Pi 的配置目录里，跟随 `PI_CODING_AGENT_DIR` |

## 兼容性

- Node.js `>=22.19.0`
- Pi 1.5.0、1.5.1（本次发版检查通过）；Pi 1.3.0 / 1.4.0 本次未重新验收
- `pi-cc-monitor` 可选：自定步调 loop 需要等外部事件时会用它，loop 结束时连带停止；两者通过 `pi.events` 通信
- 与 `pi-cc-extensions` 共存。本扩展不写其他插件的配置文件；旧版本在 `pi-cc-extensions.json` 里加过的
  `cron_create`、`cron_delete`、`cron_list`、`schedule_wakeup` 这几条 `excludeRenderers` 可以删掉

## 本地开发

```bash
node --test tests/*.test.mjs
npm run typecheck
node scripts/cache-check.mjs    # 真实 provider 的缓存检查，默认用免费模型，发版前跑
```

四个仓库共同使用的 `config.ts`、`settings.ts`（以及 loop/monitor 的 `render.ts`、`tasks.ts`）以本仓库为维护源。修改后在本仓库运行 `node scripts/sync-shared.mjs` 同步到同级仓库；`node scripts/sync-shared.mjs --check` 只检查，不改文件。各仓库的 `tests/shared.test.mjs` 也会检查副本一致。

类型检查使用本地 TypeScript 开发依赖，并自动定位本地 peer dependencies 或当前安装的 Pi release；`tsconfig.json` 不再包含个人目录或旧 release 的绝对路径。可用 `PI_AGENT_DIR` 选择隔离的 Pi 安装，用 `PI_TYPESCRIPT_PATH` 指向已有的 `typescript/lib/typescript.js`。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息），扩展只能往对话末尾追加：

- **不改 system prompt**：每轮需要的规则作为隐藏消息附在这一轮后面（`before_agent_start` 返回 `message`），不写 `promptGuidelines`，不返回 `systemPrompt`。
- **不动工具集**：工具在加载时一次注册，描述是固定文本；不调用 `setActiveTools`，会话中途不改描述。
- **不改历史**：不注册 `context` / `context_with_system` / `before_provider_request`。

`tests/cache.test.mjs` 守住这三条。`scripts/cache-check.mjs` 用真实 provider 依次走一遍固定间隔 `/loop`、触发、普通对话、`/loop stop`、Monitor 事件、自定步调 `/loop` 和它的触发，逐个请求看缓存读取量：
读到的明显少于上一个请求发出的内容就报 MISS（退出码 1）。provider 偶尔会自己丢缓存，同一步骤重跑仍然 MISS 才是扩展的问题。
默认模型 `opencode-go/beam-free` 免费；`--model` 可换，脚本最后会打印本次花费。

## 与 Claude Code 的差异

行为对齐 Claude Code 2.1.308 的 `/loop`，用 Pi 扩展 API 实现。有意不同的地方：

- Esc 只取消被打断回合所属的自定步调 loop；CC 按 Esc（包括空闲时、打断无关回合时）会取消所有自定步调 loop。其他情况用 `/loop stop`。
- 固定间隔的触发里调用 `schedule_wakeup` 会被当作空操作并返回说明，防止同一个任务又被自定步调重复调度；CC 没有这条硬规则。
- 不带 `/loop` 的请求（比如"每分钟打印一次hello"）也会在建好任务后立即做一次。CC 靠模型自己调用 loop 技能做到（`CronCreate` 在 CC 里是延迟加载的工具，模型会先走技能）；本包默认直接声明 cron 工具，这里改为在 `cron_create` 的结果里加一句提示，只在普通对话里建周期任务时出现。
- 底部摘要和 `maxFires` 次数上限是额外加的；CC 主会话不显示 loop 状态，也没有次数上限。
- 自定步调 loop 结束（stop、Esc、`cron_delete`、兜底心跳用完）时，绑定的 Monitor 会被静默停止；CC 靠模型自己调用 `TaskStop`。
- Monitor 事件不会取消待触发的 wakeup，它始终是兜底心跳（与 CC 一致）。
- 没有做 CC 的 `noop` 折叠、触发时"不是用户实时输入"的安全提示、间隔边界提示和云端调度。
- 没有做 CC 针对 5 分钟提示缓存的两处调整（`*/5` 每次提前 15 秒、接近 300 秒的唤醒往回拉）。在 5 分钟缓存的 provider 上（比如 Anthropic 默认），`*/5` 的触发和 300 秒左右的唤醒可能刚好错过缓存。

## 许可证

MIT
