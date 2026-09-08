# Changelog

## 0.3.2

- Reject checkout-owned Git and Docker executables across the full repository
  boundary, including nested working directories and junction/symlink aliases.
  Apply the same protection during initial Git workspace discovery.
- Preserve effective executable permissions in verification snapshots and
  include them in stale-evidence detection.
- Retain Codex thread/turn identifiers for incomplete reviews and tracked jobs,
  without combining identifiers from different threads.
- Add an optional Windows Docker/WSL setup script using native DISM, with
  non-mutating regression tests and setup documentation.

## 0.3.1

- Reduce repeated routing-hook context: full session-start policy with compact
  subsequent reminders. Kept in a separate commit for easy reversion.

## 0.3.0

- Include warning counts in merge verdicts and distinguish native priority from
  must-fix, should-fix and note dispositions.
- Require explicit reviewer-reported coverage and verification disclosures.
- Add opt-in execution of selected checks in isolated, pinned local Docker
  images, with bounded resources, evidence capture and fail-closed cleanup.
- Allow a one-hour overall verification/review budget.
- Use short background-task descriptions while preserving the complete brief.
