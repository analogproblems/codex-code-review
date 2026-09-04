// Modified from the OpenAI Codex plugin for Claude Code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatCommandFailure, runCommand } from "./process.mjs";

export const REVIEW_COMMENT_MARKER = "<!-- codex-code-review:v1 -->";
export const MAX_REVIEW_COMMENT_CHARS = 60_000;

const PR_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "baseRefName",
  "baseRefOid",
  "headRefName",
  "headRefOid",
  "changedFiles",
  "additions",
  "deletions"
].join(",");

function checked(command, args, options = {}) {
  const run = options.runCommandImpl ?? runCommand;
  const result = run(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    shell: false
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

function git(cwd, args, options = {}) {
  return checked("git", args, { cwd, ...options });
}

function gh(cwd, args, options = {}) {
  return checked("gh", args, { cwd, ...options });
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Unable to parse ${description} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeRepoName(value) {
  const normalized = String(value ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`Invalid GitHub repository name: ${value}`);
  }
  return normalized;
}

function parsePullRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("Pull request URLs must use https://github.com/<owner>/<repo>/pull/<number>.");
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Pull request URLs must not contain credentials, ports, queries, or fragments.");
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) {
    throw new Error("Pull request URLs must use https://github.com/<owner>/<repo>/pull/<number>.");
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Pull request numbers must be positive safe integers.");
  }
  return {
    repository: normalizeRepoName(`${match[1]}/${match[2]}`),
    number
  };
}

export function normalizePullRequestReference(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized)) && Number(normalized) > 0) {
    return { repository: null, number: Number(normalized) };
  }
  const parsedUrl = parsePullRequestUrl(normalized);
  if (parsedUrl) {
    return parsedUrl;
  }
  throw new Error("The pull request must be a positive number or a full GitHub pull request URL.");
}

export function getGitHubStatus(cwd, options = {}) {
  try {
    const version = gh(cwd, ["--version"], options).stdout.trim().split(/\r?\n/)[0] || "installed";
    const auth = gh(cwd, ["auth", "status", "--hostname", "github.com"], options);
    return {
      available: true,
      authenticated: true,
      detail: `${version}; authenticated`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /** @type {NodeJS.ErrnoException} */ (error)?.code === "ENOENT";
    return {
      available: !missing,
      authenticated: false,
      detail: missing ? "not found" : message
    };
  }
}

function requireGitHub(cwd, options = {}) {
  const status = getGitHubStatus(cwd, options);
  if (!status.available) {
    throw new Error("GitHub CLI is not installed. Install `gh`, then rerun `/code-review:setup`.");
  }
  if (!status.authenticated) {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login`, then retry.");
  }
}

function currentGitHubRepository(cwd, options = {}) {
  const result = gh(cwd, ["repo", "view", "--json", "nameWithOwner"], options);
  const parsed = parseJson(result.stdout, "GitHub repository");
  return normalizeRepoName(parsed.nameWithOwner);
}

function normalizePullRequest(data, repository) {
  const number = Number(data?.number);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("GitHub returned a pull request without a valid number.");
  }
  for (const field of ["url", "state", "baseRefName", "baseRefOid", "headRefName", "headRefOid"]) {
    if (typeof data?.[field] !== "string" || !data[field].trim()) {
      throw new Error(`GitHub returned a pull request without ${field}.`);
    }
  }
  for (const field of ["baseRefOid", "headRefOid"]) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(data[field].trim())) {
      throw new Error(`GitHub returned a pull request with an invalid ${field}.`);
    }
  }
  const urlReference = normalizePullRequestReference(data.url);
  if (
    urlReference.repository.toLowerCase() !== normalizeRepoName(repository).toLowerCase() ||
    urlReference.number !== number
  ) {
    throw new Error("GitHub returned pull request metadata for a different repository or number.");
  }
  return {
    repository: normalizeRepoName(repository),
    number,
    url: data.url.trim(),
    state: data.state.trim().toUpperCase(),
    isDraft: Boolean(data.isDraft),
    baseRefName: data.baseRefName.trim(),
    baseRefOid: data.baseRefOid.trim(),
    headRefName: data.headRefName.trim(),
    headRefOid: data.headRefOid.trim(),
    changedFiles: Number(data.changedFiles) || 0,
    additions: Number(data.additions) || 0,
    deletions: Number(data.deletions) || 0
  };
}

export function resolvePullRequest(cwd, referenceValue, options = {}) {
  requireGitHub(cwd, options);
  const reference = normalizePullRequestReference(referenceValue);
  const repository = reference?.repository ?? currentGitHubRepository(cwd, options);
  const args = ["pr", "view"];
  if (reference?.number) {
    args.push(String(reference.number));
  }
  args.push("--repo", repository, "--json", PR_FIELDS);
  const result = gh(cwd, args, options);
  return normalizePullRequest(parseJson(result.stdout, "pull request"), repository);
}

export function assertReviewablePullRequest(pullRequest) {
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull request #${pullRequest.number} is ${pullRequest.state.toLowerCase()}, not open.`);
  }
  if (pullRequest.isDraft) {
    throw new Error(`Pull request #${pullRequest.number} is a draft.`);
  }
}

function flattenCommentPages(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

export function hasExistingReviewComment(cwd, pullRequest, options = {}) {
  const endpoint = `repos/${pullRequest.repository}/issues/${pullRequest.number}/comments`;
  const result = gh(cwd, ["api", endpoint, "--paginate", "--slurp"], {
    ...options,
    maxBuffer: 16 * 1024 * 1024
  });
  const comments = flattenCommentPages(parseJson(result.stdout || "[]", "pull request comments"));
  return comments.some((comment) => typeof comment?.body === "string" && comment.body.includes(REVIEW_COMMENT_MARKER));
}

function normalizeGitHubRemoteUrl(value) {
  const raw = String(value ?? "").trim();
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      return `${match[1]}/${match[2]}`.replace(/\.git$/i, "").toLowerCase();
    }
  }
  return null;
}

export function findMatchingRemote(cwd, repository, options = {}) {
  const expected = normalizeRepoName(repository).toLowerCase();
  const remotes = git(cwd, ["remote"], options).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  for (const remote of remotes) {
    // Read the configured value directly. `git remote get-url` applies
    // url.*.insteadOf rewriting, which can hide the GitHub identity.
    const urls = git(cwd, ["config", "--get-all", `remote.${remote}.url`], options).stdout.split(/\r?\n/);
    if (urls.some((url) => normalizeGitHubRemoteUrl(url) === expected)) {
      return remote;
    }
  }
  throw new Error(`No configured git remote matches the pull request base repository ${repository}.`);
}

function validateBaseBranch(cwd, branch, options = {}) {
  git(cwd, ["check-ref-format", `refs/heads/${branch}`], options);
}

function resolveRef(cwd, ref, options = {}) {
  return git(cwd, ["rev-parse", "--verify", ref], options).stdout.trim();
}

function safeJobToken(jobId) {
  const normalized = String(jobId ?? "review").replace(/[^A-Za-z0-9._-]+/g, "-");
  return normalized || "review";
}

function assertPluginRef(ref) {
  if (!String(ref).startsWith("refs/codex-code-review/")) {
    throw new Error(`Refusing to manage non-plugin ref ${ref}.`);
  }
}

function assertPluginTempPath(value) {
  const resolved = path.resolve(value);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, resolved);
  const parent = relative.split(path.sep)[0] ?? "";
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !parent.startsWith("codex-code-review-")) {
    throw new Error(`Refusing to manage non-plugin temporary path ${value}.`);
  }
  return resolved;
}

export async function cleanupPullRequestCheckout(repoRoot, checkout, options = {}) {
  if (!checkout) {
    return { status: "not-needed", errors: [], cleanupCommand: null };
  }
  const errors = [];
  const worktreePath = assertPluginTempPath(checkout.worktreePath);
  const tempRoot = assertPluginTempPath(checkout.tempRoot);
  const refs = [checkout.baseRef, checkout.headRef].filter(Boolean);
  for (const ref of refs) {
    assertPluginRef(ref);
  }

  if (fs.existsSync(worktreePath)) {
    let removed = false;
    for (const delayMs of [0, 200, 1000]) {
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        git(repoRoot, ["worktree", "remove", "--force", worktreePath], options);
        removed = true;
        break;
      } catch (error) {
        if (delayMs === 1000) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (removed && fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } else if (fs.existsSync(tempRoot)) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const ref of refs) {
    try {
      git(repoRoot, ["update-ref", "-d", ref], options);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const cleanupCommand = errors.length
    ? [
        `git worktree remove --force ${JSON.stringify(worktreePath)}`,
        `node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" ${JSON.stringify(tempRoot)}`,
        `git update-ref -d ${JSON.stringify(checkout.baseRef)}`,
        `git update-ref -d ${JSON.stringify(checkout.headRef)}`
      ].join("\n")
    : null;
  return {
    status: errors.length ? "needs-attention" : "cleaned",
    errors,
    cleanupCommand,
    worktreePath,
    refs
  };
}

export async function createPullRequestCheckout(cwd, pullRequest, jobId, options = {}) {
  const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"], options).stdout.trim();
  const remote = findMatchingRemote(repoRoot, pullRequest.repository, options);
  validateBaseBranch(repoRoot, pullRequest.baseRefName, options);

  const token = safeJobToken(jobId);
  const baseRef = `refs/codex-code-review/${token}/base`;
  const headRef = `refs/codex-code-review/${token}/head`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-code-review-pr-${pullRequest.number}-`));
  const worktreePath = path.join(tempRoot, "checkout");
  const checkout = { repoRoot, remote, baseRef, headRef, tempRoot, worktreePath };

  try {
    git(
      repoRoot,
      [
        "fetch",
        "--no-tags",
        "--force",
        remote,
        `+refs/heads/${pullRequest.baseRefName}:${baseRef}`,
        `+refs/pull/${pullRequest.number}/head:${headRef}`
      ],
      options
    );
    const fetchedBaseOid = resolveRef(repoRoot, baseRef, options);
    const fetchedHeadOid = resolveRef(repoRoot, headRef, options);
    if (fetchedBaseOid.toLowerCase() !== pullRequest.baseRefOid.toLowerCase()) {
      throw new Error(`Pull request base changed while preparing the review (expected ${pullRequest.baseRefOid}, fetched ${fetchedBaseOid}).`);
    }
    if (fetchedHeadOid.toLowerCase() !== pullRequest.headRefOid.toLowerCase()) {
      throw new Error(`Pull request head changed while preparing the review (expected ${pullRequest.headRefOid}, fetched ${fetchedHeadOid}).`);
    }
    git(repoRoot, ["worktree", "add", "--detach", worktreePath, headRef], options);
    return checkout;
  } catch (error) {
    const cleanup = await cleanupPullRequestCheckout(repoRoot, checkout, options).catch(() => null);
    if (cleanup?.status === "needs-attention") {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nCleanup required: ${cleanup.cleanupCommand}`);
    }
    throw error;
  }
}

export function assertPullRequestUnchanged(before, after) {
  assertReviewablePullRequest(after);
  if (before.repository.toLowerCase() !== after.repository.toLowerCase() || before.number !== after.number) {
    throw new Error("GitHub returned a different pull request while revalidating the review.");
  }
  if (before.headRefOid.toLowerCase() !== after.headRefOid.toLowerCase()) {
    throw new Error("The pull request head changed during review. No comment was posted; rerun the review.");
  }
  if (before.baseRefOid.toLowerCase() !== after.baseRefOid.toLowerCase()) {
    throw new Error("The pull request base changed during review. No comment was posted; rerun the review.");
  }
}

export function renderPullRequestComment(reviewText, pullRequest) {
  const footer = [
    "",
    "---",
    `Generated by [Codex](https://openai.com/codex/) via Claude Code for ${pullRequest.repository}#${pullRequest.number}.`
  ].join("\n");
  const prefix = `${REVIEW_COMMENT_MARKER}\n### Codex code review\n\n`;
  const raw = String(reviewText ?? "").trim() || "Codex completed the review without returning findings.";
  const available = Math.max(0, MAX_REVIEW_COMMENT_CHARS - prefix.length - footer.length);
  const truncated = raw.length > available;
  const body = truncated
    ? `${raw.slice(0, Math.max(0, available - 96)).trimEnd()}\n\n_Review truncated; use \`/code-review:result\` for the complete local output._`
    : raw;
  return `${prefix}${body}${footer}`.slice(0, MAX_REVIEW_COMMENT_CHARS);
}

export function postPullRequestComment(cwd, pullRequest, body, options = {}) {
  const endpoint = `repos/${pullRequest.repository}/issues/${pullRequest.number}/comments`;
  const result = gh(
    cwd,
    ["api", "--method", "POST", endpoint, "--input", "-"],
    { ...options, input: JSON.stringify({ body }), maxBuffer: 4 * 1024 * 1024 }
  );
  const response = parseJson(result.stdout, "posted pull request comment");
  if (typeof response?.html_url !== "string" || !response.html_url.trim()) {
    throw new Error("GitHub posted the review but did not return the comment URL.");
  }
  return {
    url: response.html_url.trim(),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}
