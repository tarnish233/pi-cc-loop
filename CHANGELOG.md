# Changelog — pi-cc-loop

## [Unreleased]

## [0.12.0] - 2026-11-23

### Changed
- Redraw a scheduled fire in Claude Code's notification shape: one collapsed line with the label, the model's `reason`, the stamp and the cadence, no preview rows (the prompt is behind the expansion), and a tool-card background with a `Schedule`/`Late`/`Reason`/`Job`/`Prompt` section tree on expansion. A missed-jobs card warns with `⚠`. The title carries the same colour as its icon.
- Adapt the expand affordance to the host screen through native interfaces only: the fullscreen alt screen says `click to show more` and toggles on a left click (`Component.handleMouse`); the regular screen says `ctrl+o to show more` from `options.keyHint("app.tools.expand", …)` because it delivers no mouse events. Ctrl+O still goes through the host's own `CustomMessageComponent.setExpanded`. The hint brightens while the pointer rests on it, cleared by the same fullscreen viewport interception pi-cc-extensions uses.
### Removed
- The unused `renderBlock` helper in the shared `render.ts` (loop and monitor stay byte-identical).

## [0.11.2] - 2026-11-18

### Fixed
- Catch settings-panel save failures locally, restore the effective value, and refuse to overwrite valid settings that cannot be read because of an I/O error.
- Keep durable-file synchronization honest after single-job writes; late fires and post-arm saves update only still-existing jobs instead of resurrecting cancelled tasks.
- Persist the actual armed next-fire time on durable takeover, retaining the best-effort retry when its first persistence fails.
- Prevent stopped self-paced runs from rearming under a reworded prompt, including first-run steering, pre-start compaction gaps, and queued Monitor messages from a retired chain. Fresh user restarts and unrelated chains remain available.
- Advance cron minutes monotonically in epoch time across daylight-saving rollback.
- Restore loop.md or maintenance instructions in the current run after compaction/tree context loss. A single-read supplement snapshot is acknowledged at message_end, so successful Monitor wakeups do not keep appending the full task body and failed starts remain retryable.
- Fit long and wide task-detail labels to their actual terminal-column budget so wrapped values do not lose characters.

### Changed
- Remove unused task-panel fields/helpers, duplicate footer state, and never-populated queued-run ownership fields; preserve native mouse navigation and local stop confirmation.
- Expand regression coverage for file errors, multi-session cancellation races, real host startup/receipt ordering and Unicode display boundaries. This release was verified against Pi 1.5.2.

## [0.11.1] - 2026-11-18

### Fixed
- Re-arming a self-paced wakeup that came due while the agent was busy honours the new delay instead of firing immediately at the end of the turn.
- A damaged `.pi/scheduled_tasks.json` is never overwritten: a write refuses a file it cannot parse or that is not a jobs document, so other sessions' jobs survive.
- `schedule_wakeup` with `stop: true` from a fixed-interval tick no longer cancels unrelated self-paced loops; it names the cron job and points at `cron_delete`.
- Accept leap-day cron expressions such as `0 0 29 2 *` that fall inside the scheduler's four-year search window.
- Reject malformed cron steps such as `*/2/3` instead of silently applying the first step.
- Restarting a stopped `/loop 15m` or `/loop 15m <task>` works again, without unblocking unrelated stopped loops.
- Truncate the collapsed loop card header by terminal columns, so emoji, CJK and ANSI prompts no longer split characters or render the whole loop.md body.
- `/tasks`: keep Detail/Stop clickable when a long "new task" announcement is shown, drop invisible hit regions in the single-line layout, repaint after a scrollbar press so clicks match the painted frame, and ignore presses on a one-row scrollbar instead of jumping back to the top.
- `/tasks`: always offer a mouse Back/Close when the title control is unavailable — short terminals, narrow frames, and the status line shown after a stop.
- Log tails no longer discard a complete first line when the byte limit lands exactly on a line boundary.

## [0.11.0] - 2026-11-17

### Added
- Support native mouse navigation throughout `/tasks`: clickable tabs/tasks/actions, single-click selection, double-click details, draggable scrollbars, visible scroll ranges, and source-group collapse/expand with mouse or arrow keys.

### Changed
- Show task root groups and siblings newest-first by their creation timestamps, including mixed-provider All views, while retaining source grouping and stable selection on refresh.

### Fixed
- Handle Pi's native wheel/trackpad input in task lists and details using live viewport bounds. Contain scrolling at either end and during stop confirmation so the underlying transcript never moves.
- Make long stop-scope explanations scrollable while Cancel/Stop remain visible; repeated mouse clicks cannot reuse a dismissed confirmation or stop a task twice.

## [0.10.1] - 2026-11-14

### Fixed
- Show self-paced loops as `active` while awaiting reschedule instead of inventing `next <1m`, and calculate mixed-task countdowns from genuinely scheduled jobs only.

## [0.10.0] - 2026-11-14

### Added
- Simplify the shared task UI: a sole provider no longer gets a duplicate All tab, settings show only loaded-package pages, log details cache unchanged files and wrap long lines, and pending loops display `waiting` in the footer.

### Changed
- Shorten model-facing loop and tool prompts with dedicated stop/status rules, conditional Monitor guidance, consistent offset cron examples and fixed-only durable/max-fire flags. `/loop stop/status` remain model-driven and Monitor's default mode is unchanged.
- Scope `/pi_cc` ownership and capabilities to each Pi runtime. Independent sessions each get the command, mixed-version registries remain compatible, and text commands can still preconfigure unloaded packages.
- Consolidate shared time formatting, remove unused task/stream fields, and use portable Pi/TypeScript discovery for repository type checking.

### Fixed
- Route `/loop stop <id>` through `cron_delete` for both cron and self-paced jobs instead of risking cancellation of every self-paced loop.
- Roll back fire counts when delivery fails, keep one-shots and wakeups retryable, preserve durable records, and resend complete loopfile/maintenance content after a rejected delivery.
- Report the configured recurring expiry policy, including disabled expiry, and truncate loop.md by UTF-8 bytes without splitting multibyte characters.

## [0.9.0] - 2026-11-14

### Added
- Source-aware Monitor task/subscription grouping and role labels in the shared task panel, with provider-isolated selection and stable parent/sibling order.
- Semantic Monitor detail sections and resource-specific local stop confirmation; Loop's existing flat-row details and stop lifecycle remain unchanged.

### Changed
- Prefer sectioned provider details without rendering their legacy flat fallback twice; retain compatibility with providers using flat rows only.
- Highlight normal stopped/exited states with the theme accent color; completed remains success, failures error, and abnormal endings warning.
- Share bounded sanitized log-tail reading with Monitor and synchronize the common settings parser and panel.
- Generate task-panel tabs from loaded providers so Monitor and Loop can share one overlay without empty tabs for packages that are not installed.
- Use CC-style count-first footer labels: `1 loop` / `2 loops`, aligned with `1 monitor` / `2 monitors`.

## [0.8.0] - 2026-11-10

### Added
- Shared native Monitor/Loop task overlay with All, Monitor and Loop tabs, task details, bounded sanitized log tails, and locally confirmed stop actions. It opens during a running turn without invoking the model, changing tools or interrupting the main agent.
- A compact themed task card with solid backgrounds, selection/tab highlighting, responsive terminal resizing, pagination and detail scrolling, including dark/light and truecolor/256-color coverage.
- SDK, lifecycle, appearance and sanitization regression tests for the task panel, shared registry and command selection.

### Changed
- Register exactly one task-panel command after startup discovery: `/tasks` when the name is free, otherwise `/cc-tasks` when already-loaded extension commands or prompt templates own it. No unconditional alias or legacy underscore entry is registered.
- Scope the scheduler and shared task registry to the owning Pi runtime. Either package works alone; co-installation shares one panel and reload cleans up the old instance.
- Panel stop actions reuse the existing scheduler, durable-store and monitor lifecycles. Stopping a self-paced loop also retires its bound monitors and prevents late wakeups from reviving it.

### Fixed
- Persist the actual armed next-fire time when acquiring a durable task and preserve finite stored next-fire times for foreign tasks, including overdue tasks waiting for their owner to become idle.

## [0.7.9] - 2026-11-03

### Added
- Repository-side `scripts/compat-check.mjs` checks this package and its siblings against an installed Pi release: all host aliases, runtime imports, real extension loading, tool schemas, and themes. It supports Pi 1.4.0 and 1.5.0, rejects inspection failures instead of silently skipping them, and can be invoked through a symlink.
- Regression coverage for canonical and legacy host imports, incompatible schemas, Pi 1.4's compatibility exports, and single-release test environments.

### Changed
- Tool-schema tests use the installed Pi's real `validateToolArguments`, with TypeBox on older releases and `pi-schema` on Pi 1.5.0. They strictly check complete coerced arguments, Pi's rejection messages, JSON-visible data, and symbol metadata, and run in isolated single-release installations.
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
