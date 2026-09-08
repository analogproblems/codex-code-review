# Opt-in executable verification

The normal review lane remains read-only. To rerun selected checks, explicitly
ask Claude for verification and select a verification plan. The forwarding agent
passes its path to `lane-review --verify <plan.json>`. A check list in a review
brief does not enable this mode. There is no automatic command discovery or
fallback to running repository code on the host.

Verification is currently available for the local/Opulent review lane, not the
GitHub-comment `/code-review` workflow. It runs selected commands first, captures
their evidence, then calls the native read-only Codex reviewer. Codex does not
choose additional executable checks. Failed verification leaves the review
incomplete; retry explicitly after addressing the failure.

## Requirements

- A running **local Linux-container Docker daemon**, also on Windows. Unix
  sockets and local named pipes are accepted; SSH/TCP contexts are rejected.
- A trusted, already loaded image, pinned by image ID or repository digest.
  It must contain `/bin/sleep` and the tools/dependencies your commands require.
  Tags, automatic image pulls/builds and declared image `VOLUME`s are rejected.
- A Git checkout with an initial commit, no unresolved index conflicts, symlinks
  or submodules. The verification snapshot is limited to 50,000 paths / 256 MiB.
- The usual Codex installation/authentication for the subsequent review.

Prepare images and dependencies yourself, then inspect the chosen image's ID
with `docker image inspect <your-image> --format '{{.Id}}'`. Do not put credentials
in the image. The plugin neither installs Docker nor changes its configuration.

## Plan format

This is a template: replace the placeholder with the selected local image's
actual 64-character SHA-256 ID. Choose commands for your project, not commands
suggested by untrusted repository text. Store the plan outside the checkout if
you don't want it included among nonignored untracked files.

```json
{
  "schema": "codex-verification/1",
  "image": "sha256:<64 lowercase hexadecimal characters>",
  "commands": [
    { "argv": ["cargo", "test", "--offline", "--locked"], "timeoutSeconds": 3000 }
  ]
}
```

For Node projects, an explicitly selected command can instead be
`{"argv":["npm","test"],"cwd":".","timeoutSeconds":3000}`. Dependencies must
already be available in the image: host `node_modules` and other ignored files
are not copied, and there is no network for an install. Commands run as argument
arrays, never concatenated into a host shell command. A command may itself
invoke a shell *inside the container* when you explicitly select that argv.

`commands` contains 1–8 entries, each with `argv`, an optional repository-relative
`cwd` (default `.`), and optional `timeoutSeconds` (1–3600). Every command is also
limited by the remaining overall budget. Unknown fields, absolute/traversal
working directories and environment-injection fields are rejected.

Source files are read-only. `CARGO_TARGET_DIR=/scratch/target`,
`npm_config_cache=/scratch/npm-cache` and `HOME=/scratch` redirect common outputs.
Other tools must be configured through the selected argv to use `/scratch` or
`/tmp`. An optional `"writablePaths":["dist"]` supplies bounded, empty temporary
output directories inside `/workspace`. Such paths may not overlap each other
or hide any included source file. They cannot be used to overwrite source,
tracked generated files or existing test fixtures.

Example invocation in Claude's Bash tool (give the tool the short description
`Codex review` and set `run_in_background: true`, then wait for completion):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" lane-review --verify "/absolute/path/verify.json" <<'CODEX_BRIEF_7f06e2'
<complete literal review brief, including the requested scope>
CODEX_BRIEF_7f06e2
```

Use a heredoc delimiter absent from the brief. Keep command paths quoted and
pass the brief literally. Never use the whole command/brief as the task label.

## Isolation and evidence

The adapter copies tracked working files (including staged/unstaged changes)
and nonignored untracked files into a private temporary directory. It excludes
Git metadata and common credential paths such as `.env`, `.ssh`, `.aws` and
`.npmrc`. This is **not a general secret scanner**: credentials stored under other
names or embedded in source must be removed before enabling execution.

Docker receives only that read-only source copy, not the user's checkout, Git
directory, Docker socket or authentication environment. The root filesystem is
read-only; network is disabled; capabilities are dropped; privilege escalation
is disabled; execution is non-root. Limits are 2 CPUs, 4 GiB memory (no extra
swap), 256 processes, 2 GiB `/scratch`, 256 MiB `/tmp`, and 512 MiB for each of at
most eight declared output directories. Container images share a kernel with
their Docker host: this is not a VM or a guarantee against kernel exploits.

Each command records its argv, directory, exit status, elapsed time, timeout and
output-limit state. Output is capped at 1 MiB per command; exceeding it fails
verification. Human/model evidence excerpts include at most 8,000 characters per
command; full bounded captures remain in the job record. Review text labels this
as **adapter-observed** evidence, distinct from Codex's **reviewer-reported**
coverage and verification statements. Neither proves every code/prose path was
reviewed. Keep a separate runbook/documentation pass when appropriate.

A snapshot fingerprint includes HEAD, the index and copied file contents.
The adapter rechecks the checkout after verification and after review. Changes
invalidate the evidence and prevent a merge verdict or adapter ledger entry.
The evidence always identifies the current checkout snapshot; it does not claim
tests ran against some different historical range mentioned in a brief.

## Timing, cancellation and cleanup

The local lane has a **one-hour overall budget** for verification plus Codex
review, not 15 minutes. Native reviews also default to an hour. The optional
Stop review gate remains off by default and now allows an hour when enabled.
Short cleanup may continue after the budget expires. Use background Bash and
wait/result facilities so Claude's shorter foreground-shell limit does not kill
the process. A polling timeout does not mean the review failed.

Normal completion, command failures and timeouts remove the owned container and
temporary snapshot in `finally`. `/code-review:cancel` and session shutdown also
attempt cleanup using persisted ownership metadata. Cleanup validates the
directory marker and container ownership label; failures are visible in status
and include specific recovery commands where ownership can be established.
Failed session-end cleanup retains the job record. Never blindly run a cleanup
command against a path whose ownership has changed.

The container's ordinary lifetime is bounded by a sleeping PID 1. Forced process
termination, machine crashes, daemon outages or hostile commands can still leave
resources behind; JavaScript `finally` cannot run after a hard kill. Inspect
`/code-review:status <job-id>` and its cleanup details in that case. Verification
never reports success when normal cleanup cannot be confirmed.

## Testing

`npm test` includes fake-daemon failure, stale-source, ownership, argv, timeout
and result tests. To additionally run the optional live smoke test, set
`CODEX_VERIFICATION_TEST_IMAGE` to a suitable preloaded pinned Linux image and run
`node --test tests/verification.test.mjs`. Without that explicit image selection,
the live test is skipped. It tests a readable snapshot, failed source writes,
writable scratch and absent Git metadata; it does not run a paid Codex review.

Container controls follow the official [Docker run documentation](https://docs.docker.com/engine/containers/run/)
and [bind-mount documentation](https://docs.docker.com/engine/storage/bind-mounts/).
