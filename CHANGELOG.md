# Changelog — pi-cc-loop

## [Unreleased]

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
