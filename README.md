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
| 底部摘要 | Pi 底部状态栏一行：`loop 2 · next 3m`，无任务时不占位 | `/pi_cc footer on\|off` |
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
```

前五个会作为普通 user 消息进入对话（内容就是你输入的那行），模型再按技能说明调用工具；后两个只改界面，不进对话。
旧的 `/loop footer`、`/loop settings` 会提示改用 `/pi_cc`，不会当成 loop 请求。

间隔写法没有约束，模型自己解析：`30s`、`5m`、`2h`、`1d`、`check the deploy every 20m`、
`每2分钟输出一次`、`每分钟打印一次hi` 都可以。小于一分钟会向上取整到每分钟。

可以在请求里加 `--durable`（写入 `.pi/scheduled_tasks.json`，重启后继续）和 `--max N`（触发 N 次后自动删除）。

## 工具

| 工具 | 界面显示 | 说明 |
| --- | --- | --- |
| `cron_create` | `CronCreate` | 5 段 cron（本地时区）+ prompt；`recurring` 默认 `true`，`false` 为一次性；可选 `durable`、`maxFires` |
| `cron_delete` | `CronDelete` | 按 id 取消；也能结束自定步调 loop |
| `cron_list` | `CronList` | 列出任务和实际的下次运行时间（已含错峰） |
| `schedule_wakeup` | `ScheduleWakeup` | 自定步调：`delaySeconds`（限制在 60–3600）、`reason`（必填，显示在触发块表头）、`prompt`；`stop: true` 结束 |

四个工具都声明了 `outputSchema`：开了 codemode 时，脚本里 `tools.cron_create(...)`、`tools.cron_list()` 拿到的是结构化结果（`{ id, nextFireAt, … }`、`{ jobs: [...] }`），一个脚本里就能列任务、按条件批量取消，不用从文本里抠 id。没开 codemode 时没有影响。

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
  "footer": true,            // 底部摘要：loop 的一行和 Monitor 的 `monitor N`
  "draft": true,             // pi-cc-plugins：Ctrl+C 找回
  "turnSummary": true,       // pi-cc-plugins：回合摘要一行
  "ccKeys": true,            // pi-cc-plugins：Enter 排队、Ctrl+Enter 直发
  "compaction": true,        // pi-cc-compaction：Claude Code 的压缩
  "idleCompaction": true     // pi-cc-compaction：空闲压缩
}
```

draft、turnSummary、ccKeys 只被 pi-cc-plugins 读取，compaction、idleCompaction 只被 pi-cc-compaction 读取；没装对应包的会话里，面板中的这些项不生效，值原样保留。

在 TUI 里输入 `/pi_cc` 会打开设置面板，和 pi-cc-extensions 的 `/ccstyle` 一样按页组织，每个插件一页：
**Loop & Monitor**（消息样式、底部摘要，两个包共用）、**Plugins**（pi-cc-plugins）、**Compact**（pi-cc-compaction）。
Tab / Shift+Tab 切换页，上下键选择，Enter/空格切换，Esc 关闭；改动立即保存，所有 pi-cc 扩展同时生效。
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
| 有任务 | `loop 3 · next 4m`（数量 + 最近一次触发） |
| 一分钟内 | `loop 1 · next <1m` |
| 超过一小时 | `loop 1 · next 2h 15m` |

- 倒计时取整到分钟，配合"文本相同就不调用"的去重，最多每分钟重绘一次（Pi 每次 `setStatus` 都会触发重绘）
- 装了 `pi-cc-extensions`：这一行会作为它的一个 chip 出现在第 2 行，可在它的配置面板里移动或隐藏；它会把 ANSI 去掉，所以这里只用纯文本
- 没装 `pi-cc-extensions`：Pi 内置 footer 会把它和其他扩展的状态拼成一行，加在用量行下面，只在有任务时出现
- 装了 `pi-cc-monitor`：运行中的 monitor 另有一项 `monitor 2`，和这一行用同一个开关

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
- Pi 1.3.0、1.4.0（测试通过）
- `pi-cc-monitor` 可选：自定步调 loop 需要等外部事件时会用它，loop 结束时连带停止；两者通过 `pi.events` 通信
- 与 `pi-cc-extensions` 共存。本扩展不写其他插件的配置文件；旧版本在 `pi-cc-extensions.json` 里加过的
  `cron_create`、`cron_delete`、`cron_list`、`schedule_wakeup` 这几条 `excludeRenderers` 可以删掉

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes -p typescript@5.9.3 tsc --noEmit -p tsconfig.json
node scripts/cache-check.mjs    # 真实 provider 的缓存检查，默认用免费模型，发版前跑
```

四个仓库共同使用的 `config.ts`、`settings.ts`（以及 loop/monitor 的 `render.ts`）以本仓库为维护源。修改后在本仓库运行 `node scripts/sync-shared.mjs` 同步到同级仓库；`node scripts/sync-shared.mjs --check` 只检查，不改文件。各仓库的 `tests/shared.test.mjs` 也会检查副本一致。

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
- 不带 `/loop` 的请求（比如"每分钟打印一次hello"）也会在建好任务后立即做一次。CC 靠模型自己调用 loop 技能做到（`CronCreate` 在 CC 里是延迟加载的工具，模型会先走技能）；Pi 没有延迟加载工具，这里改为在 `cron_create` 的结果里加一句提示，只在普通对话里建周期任务时出现。
- 底部摘要和 `maxFires` 次数上限是额外加的；CC 主会话不显示 loop 状态，也没有次数上限。
- 自定步调 loop 结束（stop、Esc、`cron_delete`、兜底心跳用完）时，绑定的 Monitor 会被静默停止；CC 靠模型自己调用 `TaskStop`。
- Monitor 事件不会取消待触发的 wakeup，它始终是兜底心跳（与 CC 一致）。
- 没有做 CC 的 `noop` 折叠、触发时"不是用户实时输入"的安全提示、间隔边界提示和云端调度。
- 没有做 CC 针对 5 分钟提示缓存的两处调整（`*/5` 每次提前 15 秒、接近 300 秒的唤醒往回拉）。在 5 分钟缓存的 provider 上（比如 Anthropic 默认），`*/5` 的触发和 300 秒左右的唤醒可能刚好错过缓存。

## 许可证

MIT
