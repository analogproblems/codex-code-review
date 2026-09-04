# Codex-backed code review for Claude Code

Use Codex's native reviewer as a drop-in replacement for Claude Code's `/code-review` plugin.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

## What You Get

- `/code-review` to review the current branch's GitHub pull request and post one summary comment
- `/code-review:review` for a normal read-only Codex review
- `/code-review:adversarial-review` for a steerable challenge review
- `/code-review:rescue`, `/code-review:transfer`, `/code-review:status`, `/code-review:result`, and `/code-review:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**
- **Git and the GitHub CLI (`gh`)**, with `gh auth login` completed
- **A git remote matching the pull request's base GitHub repository**

## Install

Anthropic's same-named plugin must be disabled before enabling this replacement:

```text
/plugin disable code-review@claude-plugins-official
```

For local development, launch Claude Code with:

```bash
claude --plugin-dir ./plugins/code-review
```

Add the private marketplace repository and install the plugin:

```text
/plugin marketplace add analogproblems/codex-code-review
/plugin install code-review@codex-code-review
```

Then run:

```bash
/code-review:setup
```

`/code-review:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `code-review:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/code-review --background
/code-review:status
/code-review:result
```

## Usage

### `/code-review`

Runs Codex's native reviewer against a GitHub pull request and posts one Markdown summary comment. With no argument, it resolves the current branch's pull request. It also accepts a pull-request number or a full `https://github.com/<owner>/<repo>/pull/<number>` URL.

```bash
/code-review --wait
/code-review 123 --background
/code-review https://github.com/owner/repository/pull/123 --wait
/code-review 123 --force --wait
```

The plugin rejects closed and draft pull requests and skips a pull request it has already reviewed unless `--force` is supplied. It fetches the base and GitHub pull ref into plugin-owned refs, verifies both SHAs, and reviews a detached temporary worktree. Before posting, it rechecks the PR state, base SHA, head SHA, and duplicate marker. Failed, incomplete, or stale reviews are never posted. Comments are capped at 60,000 characters.

The review runs through an isolated direct Codex app-server with a read-only sandbox and no approvals. Only `/code-review` writes to GitHub; all `/code-review:*` commands retain their upstream behavior. Subprocesses use argument arrays and stdin rather than shell interpolation.

### `/code-review:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/code-review:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/code-review:review
/code-review:review --base main
/code-review:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/code-review:status`](#codexstatus) to check on the progress and [`/code-review:cancel`](#codexcancel) to cancel the ongoing task.

### `/code-review:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/code-review:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/code-review:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/code-review:adversarial-review
/code-review:adversarial-review --base main challenge whether this was the right caching and retry design
/code-review:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/code-review:rescue`

Hands a task to Codex through the `code-review:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/code-review:rescue investigate why the tests started failing
/code-review:rescue fix the failing test with the smallest safe patch
/code-review:rescue --resume apply the top fix from the last run
/code-review:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/code-review:rescue --model spark fix the issue quickly
/code-review:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/code-review:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/code-review:transfer
/code-review:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/code-review:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/code-review:status
/code-review:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/code-review:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/code-review:result
/code-review:result task-abc123
```

### `/code-review:cancel`

Cancels an active background Codex job.

Examples:

```bash
/code-review:cancel
/code-review:cancel task-abc123
```

### `/code-review:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/code-review:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/code-review:setup --enable-review-gate
/code-review:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/code-review:review
```

### Hand A Problem To Codex

```bash
/code-review:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/code-review:adversarial-review --background
/code-review:rescue --background investigate the flaky test
```

Then check in with:

```bash
/code-review:status
/code-review:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4-mini` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/code-review:result` or `/code-review:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/code-review:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Provenance and license

This project forks [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) at commit `db52e28f4d9ded852ab3942cea316258ae4ef346`. See [UPSTREAM.md](UPSTREAM.md). The upstream Apache-2.0 license and NOTICE are preserved.
