---
description: Run a Codex code review of local git changes
argument-hint: '[--base <ref>] [focus instructions]'
allowed-tools: Bash(node:*)
---

Review only. Do not fix anything the review reports.

Build a brief from `$ARGUMENTS`:
- With `--base <ref>`: `Scope: changes from <ref> to HEAD`. Otherwise: `Scope: working-tree changes against HEAD including untracked files`.
- Any remaining text becomes a second line, `Focus: <text>`.

Run it with `description: "Codex review"` and `run_in_background: true`, wait for it (up to one hour), then return stdout verbatim with no commentary. A nonzero exit is a failed review: show the error.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.mjs" <<'CODEX_BRIEF_6f4e91'
Scope: working-tree changes against HEAD including untracked files
CODEX_BRIEF_6f4e91
```
