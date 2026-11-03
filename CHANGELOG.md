# Changelog — pi-cc-loop

## [Unreleased]

### Added
- Repository-side `scripts/compat-check.mjs` checks this package and its siblings against an installed Pi release: all host aliases, runtime imports, real extension loading, tool schemas, and themes. It supports Pi 1.4.0 and 1.5.0, rejects inspection failures instead of silently skipping them, and can be invoked through a symlink.
- Regression coverage for canonical and legacy host imports, incompatible schemas, Pi 1.4's compatibility exports, and single-release test environments.

### Changed
- Tool-schema tests use the installed Pi's real `validateToolArguments`, with TypeBox on older releases and `pi-schema` on Pi 1.5.0. They strictly check complete coerced arguments, Pi's rejection messages, JSON-visible data, and symbol metadata, and run in isolated single-release installations.
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
