import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildLaneReviewInstructions, executeLaneReviewRun, laneVerdict, recordOpulentReview, renderLaneReview } from "../plugins/code-review/scripts/lib/lane-review.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "code-review", "scripts", "codex-companion.mjs");
const complete = { status: 0, turn: { status: "completed" }, reviewText: "No issues.\nSAFE to merge", threadId: "t1", turnId: "turn1", stderr: "" };

function optedIn(config = { schema: "pr-lane/1" }) {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".claude"));
  fs.writeFileSync(path.join(cwd, ".claude", "pr-lane.json"), JSON.stringify(config));
  return cwd;
}

test("lane review forwards the full brief to isolated native review/start with no GitHub workflow", async () => {
  const brief = 'unit: lock-2\nReview abc123..def456 in this worktree.\nHazards: concurrency\nChecks: red/green lock test\nRound 2: changed lines only\n$(touch OWNED); `exit` "quotes" --force';
  let called;
  const result = await executeLaneReviewRun({ cwd: "repo", brief }, {
    ensureGitRepository: (cwd) => assert.equal(cwd, "repo"),
    runAppServerReview: async (cwd, opts) => { called = opts; return complete; },
    recordOpulentReview: () => ({ state: "disabled" })
  });
  assert.equal(called.target.type, "custom");
  assert.ok(called.target.instructions.endsWith(brief));
  assert.equal(called.isolated, true);
  assert.equal(result.rendered, complete.reviewText + "\n");
  assert.equal(result.payload.verdict, "SAFE");
  assert.match(buildLaneReviewInstructions("Review"), /working-tree changes against HEAD/);
  assert.throws(() => buildLaneReviewInstructions("  "), /complete review brief/);
});

test("native renderer's verdict-before-findings is moved to the end without changing findings", () => {
  const text = "Found a bug.\nNOT SAFE with 1 Critical finding\n\n- [P1] Critical: Null crash — app.js:1\n  Evidence and fix.\n";
  const rendered = renderLaneReview(text);
  assert.ok(rendered.includes("- [P1] Critical: Null crash — app.js:1\n  Evidence and fix."));
  assert.ok(rendered.endsWith("NOT SAFE with 1 Critical finding"));
  assert.equal(laneVerdict(rendered), "NOT SAFE");
  for (const malformed of ["", "UNSAFE", "Probably SAFE to merge", "NOT SAFE", "No findings", "SAFE to merge\nNOT SAFE with 1 Critical finding", "SAFE to merge\nSAFE to merge", "```text\nSAFE to merge\n```", "    SAFE to merge", "> SAFE to merge"]) {
    assert.throws(() => renderLaneReview(malformed), /unambiguous merge verdict/);
  }
  const quoted = "```text\nSAFE to merge\n```\nNOT SAFE with 1 Critical finding";
  assert.equal(renderLaneReview(quoted), quoted);
  assert.equal(renderLaneReview("NOT SAFE with 1 Critical finding\n\n```text\nNOT SAFE with 1 Critical finding\n```"),
    "```text\nNOT SAFE with 1 Critical finding\n```\n\nNOT SAFE with 1 Critical finding");
});

test("ledger write failures are visible in stdout without changing the Codex verdict", async () => {
  const result = await executeLaneReviewRun({ cwd: "repo", brief: "unit: test" }, {
    ensureGitRepository: () => {}, runAppServerReview: async () => complete,
    recordOpulentReview: () => ({ state: "failed", path: "ledger.jsonl", error: "locked" })
  });
  assert.match(result.rendered, /tracking needs repair/);
  assert.equal(laneVerdict(result.rendered), "SAFE");
  assert.equal(result.payload.ledger.state, "failed");
});

test("failed, interrupted, empty and ambiguous reviews never update the ledger", async () => {
  for (const overrides of [{ status: 1 }, { turn: { status: "failed" } }, { turn: { status: "interrupted" } }, { turn: null }, { reviewText: "" }, { reviewText: "No issues found" }]) {
    await assert.rejects(executeLaneReviewRun({ cwd: "repo", brief: "unit: test" }, {
      ensureGitRepository: () => {},
      runAppServerReview: async () => ({ ...complete, ...overrides }),
      recordOpulentReview: () => assert.fail("Incomplete reviews must not be recorded")
    }), /incomplete/);
  }
});

test("Opulent ledger bridge is opt-in, preserves config, handles unit syntax and never duplicates its own configured provider", () => {
  const off = makeTempDir();
  assert.equal(recordOpulentReview(off, "unit: one", "SAFE", { env: {} }).state, "disabled");
  assert.equal(fs.existsSync(path.join(off, ".claude")), false);
  const cwd = optedIn();
  const config = fs.readFileSync(path.join(cwd, ".claude", "pr-lane.json"), "utf8");
  const record = recordOpulentReview(cwd, "PR-LANE CONTRACT v1\n- unit: auth/session-1", "NOT SAFE", { env: { CODEX_COMPANION_SESSION_ID: "session-123456" }, jobId: "review-123" });
  assert.equal(record.state, "recorded");
  const entry = JSON.parse(fs.readFileSync(record.path, "utf8"));
  assert.equal(entry.unit, "auth/session-1");
  assert.equal(entry.verdict, "NOT SAFE");
  assert.equal(entry.sid, "session-");
  assert.equal(entry.event, "reviewed");
  assert.equal(entry.by, "hook");
  assert.match(entry.note, /review-123/);
  assert.equal(fs.readFileSync(path.join(cwd, ".claude", "pr-lane.json"), "utf8"), config);
  assert.equal(recordOpulentReview(cwd, "unit: one", "unknown", { env: {} }).state, "not-recorded");
  assert.equal(recordOpulentReview(cwd, "No unit", "SAFE", { env: {} }).state, "no-unit");
  const managed = optedIn({ schema: "pr-lane/1", review: { provider: "code-review:reviewer" } });
  assert.equal(recordOpulentReview(managed, "unit: one", "SAFE", { env: {} }).state, "opulent-managed");
  assert.equal(fs.existsSync(path.join(managed, ".claude", "pr-lane")), false);
  const blocked = optedIn();
  fs.writeFileSync(path.join(blocked, ".claude", "pr-lane"), "not a directory");
  assert.equal(recordOpulentReview(blocked, "unit: one", "SAFE", { env: {} }).state, "failed");
});

for (const behavior of ["lane-review-ok", "lane-review-findings", "review-fails", "review-empty", "review-ok"]) {
  test(`lane CLI uses real subprocess protocol and tracked results: ${behavior}`, () => {
    const cwd = optedIn();
    initGitRepo(cwd);
    const bin = makeTempDir();
    installFakeCodex(bin, behavior);
    const env = { ...buildEnv(bin), CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: path.join(bin, "data"), CODEX_COMPANION_SESSION_ID: "lane-test-session" };
    const brief = 'unit: cli-test\nReview working tree\nLiteral $(touch OWNED) `touch OWNED` ; & | " --force\n';
    const result = run(process.execPath, [SCRIPT, "lane-review", "--json"], { cwd, env, input: brief });
    const success = behavior.startsWith("lane-review-");
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
    assert.equal(state.lastThreadStart.sandbox, "read-only");
    assert.equal(state.lastThreadStart.approvalPolicy, "never");
    assert.equal(state.lastThreadStart.ephemeral, true);
    assert.equal(state.lastReviewStart.target.type, "custom");
    assert.ok(state.lastReviewStart.target.instructions.endsWith(brief));
    assert.equal(state.lastTurnStart, undefined);
    assert.equal(fs.existsSync(path.join(cwd, "OWNED")), false);
    const ledger = path.join(cwd, ".claude", "pr-lane", "ledger.jsonl");
    assert.equal(fs.existsSync(ledger), success);
    if (success) {
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ledger.state, "recorded");
      const stored = run(process.execPath, [SCRIPT, "result", "--json"], { cwd, env });
      assert.equal(stored.status, 0, stored.stderr);
      assert.ok(stored.stdout.includes("Lane Review"));
    }
  });
}

test("lane CLI accepts a literal prompt file and rejects interpolated/unsupported flags", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  const bin = makeTempDir();
  installFakeCodex(bin, "lane-review-ok");
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(bin, "data"), CLAUDE_PROJECT_DIR: cwd };
  const file = path.join(cwd, "brief with spaces.txt");
  fs.writeFileSync(file, "Review exact base..head\nHazards: money\n");
  const result = run(process.execPath, [SCRIPT, "lane-review", "--prompt-file", file], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "No material issues found.\nSAFE to merge");
  for (const args of [["--write"], ["--force"], ["--background"], ["$(touch OWNED)"], []]) {
    const invalid = run(process.execPath, [SCRIPT, "lane-review", ...args], { cwd, env, input: "" });
    assert.equal(invalid.status, 1);
  }
});
