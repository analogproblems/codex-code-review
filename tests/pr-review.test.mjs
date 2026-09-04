import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { executePullRequestReviewRun } from "../plugins/code-review/scripts/codex-companion.mjs";
import {
  MAX_REVIEW_COMMENT_CHARS,
  REVIEW_COMMENT_MARKER,
  assertPullRequestUnchanged,
  assertReviewablePullRequest,
  cleanupPullRequestCheckout,
  createPullRequestCheckout,
  hasExistingReviewComment,
  normalizePullRequestReference,
  postPullRequestComment,
  renderPullRequestComment,
  resolvePullRequest
} from "../plugins/code-review/scripts/lib/pr-review.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { renderJobStatusReport, renderStoredJobResult } from "../plugins/code-review/scripts/lib/render.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/code-review/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/code-review/scripts/lib/tracked-jobs.mjs";

const PULL_REQUEST = Object.freeze({
  repository: "acme/widgets",
  number: 17,
  url: "https://github.com/acme/widgets/pull/17",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  baseRefOid: "a".repeat(40),
  headRefName: "feature/safe-review",
  headRefOid: "b".repeat(40),
  changedFiles: 2,
  additions: 14,
  deletions: 3
});

function result(command, args, overrides = {}) {
  return {
    command,
    args,
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
    ...overrides
  };
}

function checkedRun(command, args, options = {}) {
  const completed = run(command, args, options);
  assert.equal(completed.status, 0, completed.stderr);
  return completed.stdout.trim();
}

function makeGitHubRemoteFixture() {
  const root = makeTempDir("codex-pr-git-");
  const bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const working = path.join(root, "working");
  fs.mkdirSync(seed);
  checkedRun("git", ["init", "--bare", bare], { cwd: root });
  initGitRepo(seed);
  fs.writeFileSync(path.join(seed, "app.js"), "export const value = 1;\n");
  checkedRun("git", ["add", "app.js"], { cwd: seed });
  checkedRun("git", ["commit", "-m", "base"], { cwd: seed });
  const baseOid = checkedRun("git", ["rev-parse", "HEAD"], { cwd: seed });
  checkedRun("git", ["remote", "add", "origin", bare], { cwd: seed });
  checkedRun("git", ["push", "origin", "main"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "app.js"), "export const value = 2;\n");
  checkedRun("git", ["add", "app.js"], { cwd: seed });
  checkedRun("git", ["commit", "-m", "pull-request"], { cwd: seed });
  const headOid = checkedRun("git", ["rev-parse", "HEAD"], { cwd: seed });
  checkedRun("git", ["push", "origin", "HEAD:refs/pull/17/head"], { cwd: seed });
  checkedRun("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });
  checkedRun("git", ["clone", bare, working], { cwd: root });
  const githubUrl = "https://github.com/acme/widgets.git";
  checkedRun("git", ["remote", "set-url", "origin", githubUrl], { cwd: working });
  checkedRun(
    "git",
    ["config", `url.${pathToFileURL(bare).href}.insteadOf`, githubUrl],
    { cwd: working }
  );
  return {
    root,
    working,
    pullRequest: {
      ...PULL_REQUEST,
      baseRefOid: baseOid,
      headRefOid: headOid
    }
  };
}

test("pull request references accept only a number or canonical GitHub URL", () => {
  assert.deepEqual(normalizePullRequestReference("17"), { repository: null, number: 17 });
  assert.deepEqual(normalizePullRequestReference(PULL_REQUEST.url), {
    repository: "acme/widgets",
    number: 17
  });
  assert.throws(() => normalizePullRequestReference("https://evil.example/acme/widgets/pull/17"), /github\.com/);
  assert.throws(() => normalizePullRequestReference(`${PULL_REQUEST.url};whoami`), /must use/);
  assert.throws(() => normalizePullRequestReference(`${PULL_REQUEST.url}?x=$(whoami)`), /must not contain/);
  assert.throws(() => normalizePullRequestReference(`${PULL_REQUEST.url}#fragment`), /must not contain/);
  assert.throws(() => normalizePullRequestReference("--force"), /positive number/);
});

test("GitHub resolution uses argument arrays and supports current or arbitrary pull requests", () => {
  const calls = [];
  const runCommandImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "--version") return result(command, args, { stdout: "gh version fake\n" });
    if (args[0] === "auth") return result(command, args);
    if (args[0] === "repo") return result(command, args, { stdout: '{"nameWithOwner":"acme/widgets"}' });
    if (args[0] === "pr" && args[1] === "view") {
      return result(command, args, { stdout: JSON.stringify(PULL_REQUEST) });
    }
    throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
  };

  assert.equal(resolvePullRequest(".", "", { runCommandImpl }).number, 17);
  assert.equal(resolvePullRequest(".", PULL_REQUEST.url, { runCommandImpl }).repository, "acme/widgets");
  assert.ok(calls.every((call) => call.command === "gh" && call.options.shell === false));
  assert.ok(calls.some((call) => call.args.includes("--repo") && call.args.includes("acme/widgets")));
});

test("missing GitHub authentication is diagnosed before pull request access", () => {
  const runCommandImpl = (command, args) => {
    if (args[0] === "--version") return result(command, args, { stdout: "gh version fake\n" });
    if (args[0] === "auth") return result(command, args, { status: 1, stderr: "not logged in" });
    throw new Error("pull request access should not be attempted");
  };
  assert.throws(
    () => resolvePullRequest(".", "17", { runCommandImpl }),
    /GitHub CLI is not authenticated/
  );
});

test("draft and closed pull requests are rejected", () => {
  assert.throws(() => assertReviewablePullRequest({ ...PULL_REQUEST, state: "CLOSED" }), /not open/);
  assert.throws(() => assertReviewablePullRequest({ ...PULL_REQUEST, isDraft: true }), /draft/);
});

test("private marker detects prior reviews and force can bypass orchestration checks", async () => {
  const runner = (command, args) =>
    result(command, args, {
      stdout: args[0] === "api" ? JSON.stringify([[{ body: `hello\n${REVIEW_COMMENT_MARKER}` }]]) : ""
    });
  assert.equal(hasExistingReviewComment(".", PULL_REQUEST, { runCommandImpl: runner }), true);

  let duplicateChecks = 0;
  let reviewCalls = 0;
  let postCalls = 0;
  const execution = await executePullRequestReviewRun({
    cwd: ".",
    pullRequest: "17",
    force: true,
    jobId: "force-test",
    operations: {
      ensureCodexAvailable() {},
      ensureGitRepository() {},
      resolvePullRequest: () => ({ ...PULL_REQUEST }),
      assertReviewablePullRequest,
      hasExistingReviewComment: () => {
        duplicateChecks += 1;
        return true;
      },
      createPullRequestCheckout: async () => ({ repoRoot: ".", worktreePath: ".", baseRef: "refs/base" }),
      runAppServerReview: async () => {
        reviewCalls += 1;
        return { status: 0, reviewText: "No issues found.", stderr: "", reasoningSummary: [] };
      },
      assertPullRequestUnchanged,
      renderPullRequestComment,
      postPullRequestComment: () => {
        postCalls += 1;
        return { url: "https://github.com/acme/widgets/pull/17#issuecomment-1", stdout: "", stderr: "" };
      },
      cleanupPullRequestCheckout: async () => ({ status: "cleaned", errors: [], cleanupCommand: null })
    }
  });
  assert.equal(execution.exitStatus, 0);
  assert.equal(duplicateChecks, 0);
  assert.equal(reviewCalls, 1);
  assert.equal(postCalls, 1);
});

test("an existing marker skips Codex and posting unless force is supplied", async () => {
  let cleanup = null;
  const execution = await executePullRequestReviewRun({
    cwd: ".",
    pullRequest: "17",
    force: false,
    jobId: "duplicate-test",
    onCleanup: (value) => {
      cleanup = value;
    },
    operations: {
      ensureCodexAvailable() {},
      ensureGitRepository() {},
      resolvePullRequest: () => ({ ...PULL_REQUEST }),
      assertReviewablePullRequest,
      hasExistingReviewComment: () => true,
      createPullRequestCheckout: async () => {
        throw new Error("checkout must not run");
      }
    }
  });
  assert.equal(execution.payload.skipped, "duplicate");
  assert.equal(execution.payload.comment, null);
  assert.equal(cleanup.status, "not-needed");
});

test("comment posting uses stdin, never shell interpolation, and enforces the safety limit", () => {
  const hostile = `finding text\n$(whoami)\n'; Remove-Item -Recurse C:\\\\important; #\n${"x".repeat(70_000)}`;
  const body = renderPullRequestComment(hostile, PULL_REQUEST);
  assert.ok(body.startsWith(REVIEW_COMMENT_MARKER));
  assert.ok(body.length <= MAX_REVIEW_COMMENT_CHARS);
  assert.match(body, /Review truncated/);
  assert.match(body, /Generated by \[Codex\]/);

  let captured;
  postPullRequestComment(".", PULL_REQUEST, body, {
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return result(command, args, {
        stdout: '{"html_url":"https://github.com/acme/widgets/pull/17#issuecomment-42"}\n'
      });
    }
  });
  assert.equal(captured.command, "gh");
  assert.deepEqual(captured.args, ["api", "--method", "POST", "repos/acme/widgets/issues/17/comments", "--input", "-"]);
  assert.deepEqual(JSON.parse(captured.options.input), { body });
  assert.equal(captured.options.shell, false);
});

test("repository-derived branch names remain one non-shell git argument", async () => {
  const calls = [];
  const hostileBranch = "main;Write-Output-PWNED";
  const pullRequest = { ...PULL_REQUEST, baseRefName: hostileBranch };
  const runCommandImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return result(command, args, { stdout: `${process.cwd()}\n` });
    }
    if (args[0] === "remote") return result(command, args, { stdout: "origin\n" });
    if (args[0] === "config") {
      return result(command, args, { stdout: "https://github.com/acme/widgets.git\n" });
    }
    if (args[0] === "rev-parse") {
      return result(command, args, {
        stdout: `${args.at(-1).endsWith("/base") ? pullRequest.baseRefOid : pullRequest.headRefOid}\n`
      });
    }
    return result(command, args);
  };
  const checkout = await createPullRequestCheckout(".", pullRequest, "hostile-branch", { runCommandImpl });
  const fetch = calls.find((call) => call.args[0] === "fetch");
  assert.ok(fetch.args.includes(`+refs/heads/${hostileBranch}:${checkout.baseRef}`));
  assert.ok(calls.every((call) => call.options.shell === false));
  await cleanupPullRequestCheckout(checkout.repoRoot, checkout, { runCommandImpl });
});

test("fork pull refs are reviewed in a detached worktree and fully cleaned", async () => {
  const fixture = makeGitHubRemoteFixture();
  const originalHead = checkedRun("git", ["rev-parse", "HEAD"], { cwd: fixture.working });
  const checkout = await createPullRequestCheckout(fixture.working, fixture.pullRequest, "fork-test");
  assert.equal(checkedRun("git", ["rev-parse", "HEAD"], { cwd: checkout.worktreePath }), fixture.pullRequest.headRefOid);
  assert.equal(checkedRun("git", ["rev-parse", "HEAD"], { cwd: fixture.working }), originalHead);
  assert.equal(checkedRun("git", ["rev-parse", checkout.baseRef], { cwd: fixture.working }), fixture.pullRequest.baseRefOid);
  const cleanup = await cleanupPullRequestCheckout(fixture.working, checkout);
  assert.equal(cleanup.status, "cleaned");
  assert.equal(fs.existsSync(checkout.tempRoot), false);
  assert.notEqual(run("git", ["rev-parse", "--verify", checkout.baseRef], { cwd: fixture.working }).status, 0);
  assert.notEqual(run("git", ["rev-parse", "--verify", checkout.headRef], { cwd: fixture.working }).status, 0);
});

test("Windows-style worktree locking surfaces complete manual cleanup commands", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-code-review-lock-test-"));
  const worktreePath = path.join(tempRoot, "checkout");
  fs.mkdirSync(worktreePath);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const checkout = {
    tempRoot,
    worktreePath,
    baseRef: "refs/codex-code-review/lock-test/base",
    headRef: "refs/codex-code-review/lock-test/head"
  };
  const cleanup = await cleanupPullRequestCheckout(".", checkout, {
    runCommandImpl(command, args) {
      return result(command, args, {
        status: args[0] === "worktree" ? 1 : 0,
        stderr: args[0] === "worktree" ? "worktree is locked" : ""
      });
    }
  });
  assert.equal(cleanup.status, "needs-attention");
  assert.match(cleanup.cleanupCommand, /git worktree remove --force/);
  assert.match(cleanup.cleanupCommand, /node -e/);
  assert.match(cleanup.cleanupCommand, /lock-test\/base/);
  assert.match(cleanup.cleanupCommand, /lock-test\/head/);
});

test("a fetched SHA race aborts and cleans plugin refs", async () => {
  const fixture = makeGitHubRemoteFixture();
  await assert.rejects(
    createPullRequestCheckout(
      fixture.working,
      { ...fixture.pullRequest, headRefOid: "f".repeat(40) },
      "sha-race"
    ),
    /head changed/
  );
  const refs = checkedRun("git", ["for-each-ref", "--format=%(refname)", "refs/codex-code-review/sha-race"], {
    cwd: fixture.working
  });
  assert.equal(refs, "");
});

test("head and base races detected after review prevent posting", () => {
  assert.throws(
    () => assertPullRequestUnchanged(PULL_REQUEST, { ...PULL_REQUEST, headRefOid: "c".repeat(40) }),
    /head changed/
  );
  assert.throws(
    () => assertPullRequestUnchanged(PULL_REQUEST, { ...PULL_REQUEST, baseRefOid: "c".repeat(40) }),
    /base changed/
  );
});

test("stale, failed, incomplete, and GitHub-failed reviews never escape cleanup", async () => {
  for (const scenario of ["stale", "codex-failed", "incomplete", "github-failed"]) {
    let resolveCalls = 0;
    let posts = 0;
    let cleanups = 0;
    const operations = {
      ensureCodexAvailable() {},
      ensureGitRepository() {},
      resolvePullRequest: () => {
        resolveCalls += 1;
        return scenario === "stale" && resolveCalls === 2
          ? { ...PULL_REQUEST, headRefOid: "c".repeat(40) }
          : { ...PULL_REQUEST };
      },
      assertReviewablePullRequest,
      hasExistingReviewComment: () => false,
      createPullRequestCheckout: async () => ({ repoRoot: ".", worktreePath: ".", baseRef: "refs/base" }),
      runAppServerReview: async () => ({
        status: scenario === "codex-failed" ? 1 : 0,
        reviewText: scenario === "incomplete" ? "" : "No issues found.",
        stderr: scenario === "codex-failed" ? "Codex failed" : "",
        reasoningSummary: []
      }),
      assertPullRequestUnchanged,
      renderPullRequestComment,
      postPullRequestComment: () => {
        posts += 1;
        if (scenario === "github-failed") throw new Error("GitHub refused comment");
        return { url: null, stdout: "", stderr: "" };
      },
      cleanupPullRequestCheckout: async () => {
        cleanups += 1;
        return { status: "cleaned", errors: [], cleanupCommand: null };
      }
    };
    await assert.rejects(
      executePullRequestReviewRun({ cwd: ".", pullRequest: "17", jobId: scenario, operations }),
      /changed|Codex failed|without a final review|GitHub refused/
    );
    assert.equal(cleanups, 1, scenario);
    assert.equal(posts, scenario === "github-failed" ? 1 : 0, scenario);
  }
});

test("real fake Codex review uses the isolated app-server inside the temporary worktree", async () => {
  const fixture = makeGitHubRemoteFixture();
  const binDir = makeTempDir("codex-pr-bin-");
  installFakeCodex(binDir);
  const previousPath = process.env.PATH;
  const previousBrokerEndpoint = process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  process.env.PATH = buildEnv(binDir).PATH;
  process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = "pipe:\\\\.\\pipe\\must-not-be-used";
  let postedBody = null;
  try {
    const execution = await executePullRequestReviewRun({
      cwd: fixture.working,
      pullRequest: "17",
      jobId: "app-server-test",
      operations: {
        resolvePullRequest: () => ({ ...fixture.pullRequest }),
        hasExistingReviewComment: () => false,
        postPullRequestComment: (_cwd, _pr, body) => {
          postedBody = body;
          return { url: "https://github.com/acme/widgets/pull/17#issuecomment-99", stdout: "", stderr: "" };
        }
      }
    });
    assert.equal(execution.exitStatus, 0);
    assert.match(postedBody, /Reviewed changes against refs\/codex-code-review\/app-server-test\/base/);
    assert.match(postedBody, /No material issues found/);
    assert.equal(execution.payload.cleanup.status, "cleaned");
    const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
    assert.equal(fakeState.appServerStarts, 1);
    assert.ok(fakeState.threads[0].cwd.includes("codex-code-review-pr-17-"));
    assert.equal(fs.existsSync(execution.payload.cleanup.worktreePath), false);
  } finally {
    process.env.PATH = previousPath;
    if (previousBrokerEndpoint === undefined) {
      delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
    } else {
      process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = previousBrokerEndpoint;
    }
  }
});

test("status and result output include pull request, comment, and cleanup metadata", () => {
  const job = {
    id: "pr-review-1",
    status: "completed",
    kindLabel: "pr-review",
    title: "Codex PR Review",
    repository: PULL_REQUEST.repository,
    prUrl: PULL_REQUEST.url,
    commentUrl: `${PULL_REQUEST.url}#issuecomment-99`,
    cleanupStatus: "cleaned"
  };
  const status = renderJobStatusReport(job);
  const output = renderStoredJobResult(job, { ...job, rendered: "No issues found.\n" });
  for (const text of [status, output]) {
    assert.match(text, /acme\/widgets/);
    assert.match(text, /pull\/17/);
    assert.match(text, /issuecomment-99/);
    assert.match(text, /cleaned/);
  }
});

test("tracked completion preserves background pull request metadata", async (t) => {
  const workspaceRoot = makeTempDir("codex-pr-state-");
  const job = {
    id: "pr-review-background",
    kind: "pr-review",
    kindLabel: "pr-review",
    title: "Codex PR Review",
    jobClass: "review",
    workspaceRoot,
    createdAt: new Date().toISOString()
  };
  t.after(() => fs.rmSync(resolveStateDir(workspaceRoot), { recursive: true, force: true }));
  await runTrackedJob(job, async () => {
    const running = readJobFile(resolveJobFile(workspaceRoot, job.id));
    const metadata = {
      repository: PULL_REQUEST.repository,
      prUrl: PULL_REQUEST.url,
      commentUrl: `${PULL_REQUEST.url}#issuecomment-99`,
      cleanupStatus: "cleaned"
    };
    writeJobFile(workspaceRoot, job.id, { ...running, ...metadata });
    upsertJob(workspaceRoot, { id: job.id, ...metadata });
    return {
      exitStatus: 0,
      payload: { pullRequest: PULL_REQUEST },
      rendered: "No issues found.\n",
      summary: "Review commented."
    };
  });
  const stored = readJobFile(resolveJobFile(workspaceRoot, job.id));
  const indexed = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id);
  for (const record of [stored, indexed]) {
    assert.equal(record.repository, PULL_REQUEST.repository);
    assert.equal(record.prUrl, PULL_REQUEST.url);
    assert.match(record.commentUrl, /issuecomment-99/);
    assert.equal(record.cleanupStatus, "cleaned");
  }
});
