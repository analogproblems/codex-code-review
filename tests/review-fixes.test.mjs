import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { resolveHostExecutable } from "../plugins/code-review/scripts/lib/host-executable.mjs";
import { ensureGitRepository } from "../plugins/code-review/scripts/lib/git.mjs";
import { verificationSnapshot, snapshotFileMode } from "../plugins/code-review/scripts/lib/verification.mjs";
import { executeLaneReviewRun } from "../plugins/code-review/scripts/lib/lane-review.mjs";
import { runTrackedJob, createJobProgressUpdater } from "../plugins/code-review/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, resolveStateDir, loadState } from "../plugins/code-review/scripts/lib/state.mjs";

function temporary(t) {
  const root = makeTempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("host tools exclude the whole checkout, nested markers and junction aliases", (t) => {
  const root = temporary(t), checkout = path.join(root, "repo"), trusted = path.join(root, "trusted");
  const nested = path.join(checkout, "packages", "widget"), bin = path.join(checkout, "bin");
  for (const dir of [nested, bin, trusted]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(checkout, ".git"), "gitdir: external-worktree-metadata");
  fs.mkdirSync(path.join(nested, ".git"));
  const alias = path.join(root, "alias");
  fs.symlinkSync(checkout, alias, process.platform === "win32" ? "junction" : "dir");
  const outwardAlias = path.join(checkout, "external-bin");
  fs.symlinkSync(trusted, outwardAlias, process.platform === "win32" ? "junction" : "dir");
  for (const name of ["git", "docker"]) {
    const filename = name + (process.platform === "win32" ? ".exe" : "");
    for (const dir of [bin, trusted]) fs.writeFileSync(path.join(dir, filename), "not executed", { mode: 0o755 });
    const unsafe = [bin, path.join(alias, "bin"), outwardAlias, ".", "bin"];
    const env = { PATH: [...unsafe, trusted].join(path.delimiter) };
    for (const cwd of [checkout, nested, path.join(alias, "packages", "widget")]) {
      assert.equal(resolveHostExecutable(name, cwd, env), fs.realpathSync(path.join(trusted, filename)));
      assert.throws(() => resolveHostExecutable(name, cwd, { PATH: unsafe.join(path.delimiter) }), /outside the reviewed checkout/);
    }
  }
});

test("Git bootstrap and snapshot bypass a checkout-owned PATH Git", (t) => {
  const root = temporary(t);
  initGitRepo(root);
  fs.writeFileSync(path.join(root, "app"), "source");
  assert.equal(run("git", ["add", "app"], { cwd: root }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: root }).status, 0);
  const bin = path.join(root, "bin"), nested = path.join(root, "nested");
  fs.mkdirSync(bin); fs.mkdirSync(nested);
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "git.exe" : "git"), "invalid executable", { mode: 0o755 });
  const key = Object.keys(process.env).find((key) => key.toLowerCase() === "path");
  const old = process.env[key];
  process.env[key] = bin + path.delimiter + old;
  try {
    assert.equal(fs.realpathSync(ensureGitRepository(nested)), fs.realpathSync(root));
    assert.ok(verificationSnapshot(nested).included.includes("app"));
  } finally { process.env[key] = old; }
});

test("effective executable mode honors POSIX working tree and Windows index", () => {
  assert.equal(snapshotFileMode("100755", 0o644, "linux"), 0o644);
  assert.equal(snapshotFileMode("100644", 0o755, "linux"), 0o755);
  assert.equal(snapshotFileMode("100755", 0o644, "win32"), 0o755);
  assert.equal(snapshotFileMode("100644", 0o755, "win32"), 0o644);
  assert.equal(snapshotFileMode(undefined, 0o755, "win32"), 0o644);
});

test("snapshot fingerprints and copies executable permission changes", (t) => {
  const root = temporary(t), destination = temporary(t);
  initGitRepo(root);
  const file = path.join(root, "script.sh");
  fs.writeFileSync(file, "echo test\n", { mode: 0o644 });
  assert.equal(run("git", ["add", "."], { cwd: root }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd: root }).status, 0);
  const before = verificationSnapshot(root, destination);
  if (process.platform === "win32") {
    assert.equal(run("git", ["update-index", "--chmod=+x", "script.sh"], { cwd: root }).status, 0);
  } else fs.chmodSync(file, 0o755);
  const executable = verificationSnapshot(root, destination);
  assert.notEqual(executable.fingerprint, before.fingerprint);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(destination, "script.sh")).mode & 0o777, 0o755);
    // Keep an executable index while removing x from the working tree.
    assert.equal(run("git", ["update-index", "--chmod=+x", "script.sh"], { cwd: root }).status, 0);
    const indexed = verificationSnapshot(root);
    fs.chmodSync(file, 0o644);
    assert.notEqual(verificationSnapshot(root, destination).fingerprint, indexed.fingerprint);
    assert.equal(fs.statSync(path.join(destination, "script.sh")).mode & 0o777, 0o644);
  }
});

test("incomplete verified reviews retain result and progress IDs without recording verdicts", async () => {
  const passed = { status: "passed", image: "test", commands: [], snapshot: { fingerprint: "same", head: "head", included: [], excluded: [] } };
  const request = { cwd: "unused", brief: "Review", verificationPlan: {} };
  const complete = { status: 0, turn: { status: "completed" }, threadId: "thread", turnId: "turn", reviewText: "SAFE to merge" };
  for (const kind of ["failed", "stale", "ambiguous", "throw", "pre-review"]) {
    const result = await executeLaneReviewRun(request, {
      ensureGitRepository: () => {},
      runVerification: async () => ({ ...structuredClone(passed), status: kind === "pre-review" ? "failed" : "passed" }),
      verificationSnapshot: () => ({ fingerprint: kind === "stale" ? "changed" : "same" }),
      recordOpulentReview: () => assert.fail("must not record"),
      runAppServerReview: async (_cwd, options) => {
        if (kind === "throw") {
          options.onProgress({ threadId: "thread", turnId: "turn" });
          throw new Error("interrupted");
        }
        return { ...complete, ...(kind === "failed" ? { status: 1 } : {}), ...(kind === "ambiguous" ? { reviewText: "no verdict" } : {}) };
      }
    });
    assert.equal(result.exitStatus, 1);
    assert.equal(result.payload.verdict, "unknown");
    assert.equal(result.payload.ledger.state, "not-recorded");
    assert.equal(result.threadId, kind === "pre-review" ? null : "thread");
    assert.equal(result.turnId, kind === "pre-review" ? null : "turn");
  }
});

test("tracked completion preserves progress IDs but never mixes threads and turns", async (t) => {
  const root = temporary(t);
  t.after(() => fs.rmSync(resolveStateDir(root), { recursive: true, force: true }));
  for (const changeThread of ["none", "result", "progress"]) {
    const id = `retain-${changeThread}`, update = createJobProgressUpdater(root, id);
    await runTrackedJob({ id, workspaceRoot: root }, async () => {
      update({ threadId: "thread", turnId: "turn" });
      if (changeThread === "progress") update({ threadId: "new-thread" });
      return { exitStatus: 1, payload: {}, rendered: "incomplete", ...(changeThread === "result" ? { threadId: "new-thread" } : {}) };
    });
    const stored = readJobFile(resolveJobFile(root, id));
    assert.equal(stored.threadId, changeThread !== "none" ? "new-thread" : "thread");
    assert.equal(stored.turnId, changeThread !== "none" ? null : "turn");
    const indexed = loadState(root).jobs.find((job) => job.id === id);
    assert.equal(indexed.threadId, stored.threadId);
    assert.equal(indexed.turnId, stored.turnId);
  }
});
