# Codex-backed code review for Claude Code

A minimal Claude Code plugin that hands code review to the Codex CLI. A Haiku subagent
(`code-review:reviewer`) forwards a literal review brief to `codex review` running
`gpt-6-astra` at low reasoning effort, and returns Codex's output verbatim. Claude never
reviews the code itself and never fixes what the review finds.

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.** Usage counts against your Codex limits.
- **Node.js 18.18 or later**
- **Git**
- **The Codex CLI** (`npm install -g @openai/codex`, then `codex login`)

## Install

```text
/plugin marketplace add analogproblems/codex-code-review
/plugin install code-review@codex-code-review
```

For local development, launch Claude Code with:

```bash
claude --plugin-dir ./plugins/code-review
```

Then run `/code-review:setup` to check that Codex is installed and authenticated.

## Usage

### `/code-review:review [--base <ref>] [focus]`

Runs a read-only Codex review of your local git changes. With `--base <ref>` it reviews
`<ref>..HEAD`; otherwise it reviews working-tree changes against HEAD, including untracked
files. Any remaining text becomes focus instructions.

```bash
/code-review:review
/code-review:review --base main
/code-review:review --base main question the caching and retry design
```

### `code-review:reviewer`

Claude invokes this subagent for code reviews. It takes a review brief and forwards it
verbatim on stdin to `plugins/code-review/scripts/codex-review.mjs`. A brief may name the
repository or worktree, the scope (commit range or base branch), known hazards, required
regression checks and prior findings; the script prepends a fixed review charter. Reviews
run in the background with a one-hour budget.

### Verdict contract

Every completed review ends with exactly one standalone final line:

```text
SAFE to merge with <N> warnings
NOT SAFE with <N> Critical findings and <M> warnings
```

A nonzero exit means the review failed or is incomplete. There is no Claude fallback and
no invented verdict.

## What was removed

Compared with 0.3.2 this fork no longer ships Opulent routing hooks, GitHub PR review
comments, adversarial review, the rescue/transfer/status/result/cancel commands, Docker-based
executable verification, or the Codex app-server broker and job tracking. Git history keeps
all of it at commit `85a4a6a`.

## Provenance and license

This project forks [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) at
commit `db52e28f4d9ded852ab3942cea316258ae4ef346`. See [UPSTREAM.md](UPSTREAM.md). The
upstream Apache-2.0 license and NOTICE are preserved.
