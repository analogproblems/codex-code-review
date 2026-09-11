---
description: Run a Codex code review of local git changes
argument-hint: '[--base <ref>] [focus instructions]'
allowed-tools: Bash(node:*)
---

Run a Codex review of the local git changes.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Build the review brief from `$ARGUMENTS`:
- If the arguments contain `--base <ref>`, the brief's first line is `Scope: changes from <ref> to HEAD`.
- Otherwise the first line is `Scope: working-tree changes against HEAD including untracked files`.
- Append any remaining argument text as a second line, `Focus: <remaining text>`. Omit this line when nothing remains.
- Do not add review instructions of your own or rewrite the user's intent.

Run the review with `Bash`, passing the brief on stdin through a single-quoted heredoc, with `description: "Codex review"` and `run_in_background: true`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.mjs" <<'CODEX_BRIEF_6f4e91'
Scope: working-tree changes against HEAD including untracked files
CODEX_BRIEF_6f4e91
```

Then wait for the background task to complete, allowing up to one hour.

Output rules:
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- A nonzero exit is a failed or incomplete review: show the error and do not invent a verdict.
