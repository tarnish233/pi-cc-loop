# Changelog — pi-cc-loop

## [Unreleased]

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
