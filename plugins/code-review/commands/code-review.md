---
description: Review a GitHub pull request with Codex and post one summary comment
argument-hint: '[<pr-number-or-url>] [--wait|--background] [--force]'
disable-model-invocation: false
allowed-tools: Bash(node:*), AskUserQuestion
---

Run Codex's native reviewer against a GitHub pull request and post the completed review as one pull-request comment.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraints:
- This command is review-only. Do not fix code or apply patches.
- The companion validates Git, GitHub CLI authentication, Node.js, and Codex before reviewing.
- With no pull-request argument, the companion resolves the pull request for the current branch.
- Preserve the user's arguments exactly. Do not interpolate any argument into a shell command yourself.
- A private marker prevents duplicate comments. `--force` explicitly permits another review.
- Return foreground stdout verbatim. Do not paraphrase Codex's review.

Execution mode:
- If the raw arguments include `--wait`, run in the foreground without asking.
- If the raw arguments include `--background`, launch in a Claude background task without asking.
- Otherwise use `AskUserQuestion` exactly once. Offer `Run in background (Recommended)` first and `Wait for results` second.
- The companion accepts both flags, but Claude Code's Bash `run_in_background` option is what detaches the process.

Foreground command:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pr-review "$ARGUMENTS"
```

Background launch:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pr-review "$ARGUMENTS"`,
  description: "Codex pull request review",
  run_in_background: true
})
```

Do not call `BashOutput` or wait in the same turn after a background launch. Tell the user: "Codex review started in the background. Check `/code-review:status` for progress."
