import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { parseVerificationPlan, cleanVerificationEnvironment, verificationSnapshot, runVerificationProcess, runVerification, cleanupVerification, renderVerificationReport } from "../plugins/code-review/scripts/lib/verification.mjs";
import { REVIEW_TIMEOUT_MS, withReviewTimeout } from "../plugins/code-review/scripts/lib/review-timeout.mjs";
import { executeLaneReviewRun, laneVerdict } from "../plugins/code-review/scripts/lib/lane-review.mjs";
import { renderStoredJobResult, renderJobStatusReport, renderCancelReport } from "../plugins/code-review/scripts/lib/render.mjs";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { installFakeCodex, buildEnv } from "./fake-codex-fixture.mjs";
import { upsertJob, writeJobFile, loadState, resolveStateDir } from "../plugins/code-review/scripts/lib/state.mjs";

const image = `sha256:${"a".repeat(64)}`;
const plan = { schema: "codex-verification/1", image, commands: [{ argv: ["npm", "test", "--", "$(touch OWNED); `exit`"], timeoutSeconds: 60 }], writablePaths: ["dist"] };
const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", timedOut: false, overflow: false, aborted: false, error: null, elapsedMs: 5 });

function repo(t) {
  const cwd = makeTempDir();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "original");
  assert.equal(run("git", ["add", "app.js"], { cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "initial"], { cwd }).status, 0);
  return cwd;
}

function fakeDocker(overrides = {}) {
  const calls = [];
  let token;
  return { calls, docker: path.join(os.tmpdir(), "docker" + (process.platform === "win32" ? ".exe" : "")),
    run: async (binary, argv, options) => {
      const args = argv[0] === "--config" ? argv.slice(4) : argv;
      calls.push({ binary, argv, args, options });
      if (args[0] === "context") return success(JSON.stringify(overrides.host ?? "unix:///var/run/docker.sock"));
      if (args[0] === "info") return success(overrides.os ?? "linux");
      if (args[0] === "image") return overrides.noImage ? { ...success(), exitCode: 1 } : success(JSON.stringify([{ Config: { Volumes: overrides.volumes ?? null } }]));
      if (args[0] === "create") {
        token = args[args.indexOf("--label") + 1].split("=")[1];
        return overrides.createFailure ? { ...success(), exitCode: 1, stderr: "create failed" } : success("container-id");
      }
      if (args[0] === "start") return overrides.startFailure ? { ...success(), exitCode: 1, stderr: "start failed" } : success();
      if (args[0] === "exec") { overrides.onExec?.(); return { ...success("tests passed"), ...overrides.exec }; }
      if (args[0] === "inspect") return token ? success(JSON.stringify({ "dev.codex-code-review.verification": overrides.badOwner ? "foreign" : token })) : { ...success(), exitCode: 1, stderr: "No such object" };
      if (args[0] === "rm") return overrides.cleanupFailure ? { ...success(), exitCode: 1, stderr: "locked" } : success();
      assert.fail(`Unexpected Docker call: ${JSON.stringify(args)}`);
    }
  };
}

test("verification plans require explicit pinned images and safe argv/path schema", () => {
  const parsed = parseVerificationPlan(plan);
  assert.deepEqual(parsed.commands[0].argv, plan.commands[0].argv);
  assert.equal(parsed.commands[0].cwd, ".");
  for (const patch of [
    { image: "node:latest" }, { image: "--help" }, { commands: ["npm test"] },
    { commands: [{ argv: ["--privileged"] }] }, { commands: [{ argv: ["npm", "test\n"] }] },
    { commands: [{ argv: ["npm"], timeoutSeconds: 3601 }] }, { commands: [] },
    { writablePaths: ["../outside"] }, { writablePaths: ["/tmp"] }, { writablePaths: [".env"] },
    { writablePaths: ["a,b"] }, { writablePaths: ["a\\b"] }, { writablePaths: ["a", "a/b"] },
    { network: true }, { commands: [{ argv: ["npm"], env: { TOKEN: "secret" } }] }
  ]) assert.throws(() => parseVerificationPlan({ ...plan, ...patch }));
  assert.deepEqual(cleanVerificationEnvironment({ PATH: "bin", SystemRoot: "windows", GH_TOKEN: "secret", DOCKER_HOST: "remote", HOME: "private", NODE_OPTIONS: "--require=evil" }), { PATH: "bin", SystemRoot: "windows" });
});

test("snapshot covers dirty and nonignored untracked files without checkout changes or common credentials", (t) => {
  const cwd = repo(t), destination = path.join(cwd, "ignored-snapshot");
  fs.writeFileSync(path.join(cwd, ".gitignore"), "ignored-snapshot/\nignored.txt\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "dirty");
  fs.writeFileSync(path.join(cwd, "new.md"), "runbook");
  fs.writeFileSync(path.join(cwd, ".env"), "secret");
  fs.writeFileSync(path.join(cwd, "ignored.txt"), "dependency");
  const before = run("git", ["status", "--porcelain"], { cwd }).stdout;
  const snapshot = verificationSnapshot(cwd, destination);
  assert.equal(fs.readFileSync(path.join(destination, "app.js"), "utf8"), "dirty");
  assert.ok(snapshot.included.includes("new.md"));
  assert.deepEqual(snapshot.excluded, [".env"]);
  assert.equal(fs.existsSync(path.join(destination, ".git")), false);
  assert.equal(fs.existsSync(path.join(destination, "ignored.txt")), false);
  assert.equal(run("git", ["status", "--porcelain"], { cwd }).stdout, before);
  assert.equal(verificationSnapshot(cwd).fingerprint, snapshot.fingerprint);
  fs.writeFileSync(path.join(cwd, "new.md"), "changed");
  assert.notEqual(verificationSnapshot(cwd).fingerprint, snapshot.fingerprint);
});

test("snapshot rejects indexed symlinks even on Windows without symlink privileges", (t) => {
  const cwd = repo(t);
  const hash = run("git", ["hash-object", "-w", "--stdin"], { cwd, input: "../private" }).stdout.trim();
  assert.equal(run("git", ["update-index", "--add", "--cacheinfo", `120000,${hash},link`], { cwd }).status, 0);
  assert.throws(() => verificationSnapshot(cwd), /symlinks/);
});

test("container controls, literal arguments, reports and final cleanup", async (t) => {
  const cwd = repo(t), fake = fakeDocker(), updates = [];
  const report = await runVerification({ cwd, plan, onUpdate: (p) => updates.push(structuredClone(p)) }, fake);
  assert.equal(report.status, "passed", report.error);
  const create = fake.calls.find((c) => c.args[0] === "create").args;
  for (const flag of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=256", "--memory=4g", "--cpus=2"]) assert.ok(create.includes(flag), flag);
  assert.ok(create.includes("/bin/sleep"));
  assert.equal(create.at(-2), image);
  assert.ok(Number(create.at(-1)) <= 3600);
  const mount = create[create.indexOf("--mount") + 1];
  assert.match(mount, /source=.*codex-verification-.*source,target=\/workspace,readonly$/);
  assert.ok(!mount.includes(cwd));
  assert.deepEqual(fake.calls.find((c) => c.args[0] === "exec").args.slice(-4), plan.commands[0].argv);
  assert.equal(fake.calls.some((c) => ["pull", "build"].includes(c.args[0])), false);
  assert.equal(report.cleanup.status, "cleaned");
  assert.equal(fs.existsSync(updates[0].verificationResources.root), false);
  assert.equal(updates.at(-1).verificationResources, null);
  assert.match(renderVerificationReport(report), /adapter-observed.*passed/);
});

test("verification fails closed across daemon, image, command, cancellation and cleanup failures", async (t) => {
  const cwd = repo(t);
  for (const [overrides, expected] of [
    [{ host: "ssh://other" }, "error"], [{ host: "tcp://localhost:2375" }, "error"],
    [{ os: "windows" }, "error"], [{ noImage: true }, "error"], [{ volumes: { "/data": {} } }, "error"],
    [{ createFailure: true }, "error"], [{ startFailure: true }, "error"],
    [{ exec: { exitCode: 1 } }, "failed"], [{ exec: { timedOut: true } }, "timed-out"],
    [{ exec: { overflow: true } }, "failed"], [{ exec: { aborted: true } }, "cancelled"],
    [{ cleanupFailure: true }, "cleanup-failed"], [{ badOwner: true }, "cleanup-failed"]
  ]) {
    const fake = fakeDocker(overrides); let resources;
    const report = await runVerification({ cwd, plan, onUpdate: (p) => { if (p.verificationResources) resources = p.verificationResources; } }, fake);
    assert.equal(report.status, expected, `${JSON.stringify(overrides)}: ${report.error}`);
    if (expected === "cleanup-failed") {
      assert.equal(fs.existsSync(resources.root), true);
      // These are fake containers; retry with an ownership-preserving fake.
      const retry = { run: async (bin, args) => args.includes("inspect") ? success(JSON.stringify({ "dev.codex-code-review.verification": resources.token })) : success() };
      assert.equal((await cleanupVerification(resources, retry)).status, "cleaned");
    } else assert.equal(fs.existsSync(resources.root), false);
  }
});

test("stale snapshots, hidden sources and recheck exceptions never pass", async (t) => {
  const cwd = repo(t);
  const stale = await runVerification({ cwd, plan }, fakeDocker({ onExec: () => fs.writeFileSync(path.join(cwd, "app.js"), "changed") }));
  assert.equal(stale.status, "stale");
  const hidden = await runVerification({ cwd, plan: { ...plan, writablePaths: ["app.js"] } }, fakeDocker());
  assert.equal(hidden.status, "error");
  assert.match(hidden.error, /hide source/);
  const fake = fakeDocker(); let reads = 0;
  const failedRecheck = await runVerification({ cwd, plan }, { ...fake, snapshot: (...args) => { if (reads++) throw new Error("recheck failed"); return verificationSnapshot(...args); } });
  assert.equal(failedRecheck.status, "error");
});

test("cleanup refuses unowned directories and never suggests deleting them", async (t) => {
  const cwd = repo(t);
  const cleanup = await cleanupVerification({ root: cwd, token: "x", container: "foreign" });
  assert.equal(cleanup.status, "needs-attention");
  assert.deepEqual(cleanup.commands, []);
  assert.equal(fs.existsSync(cwd), true);
});

test("subprocess runner uses literal argv and bounds time/output", async () => {
  const literal = "$(touch OWNED); `exit` & echo hacked";
  const output = await runVerificationProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal]);
  assert.equal(output.stdout, literal);
  assert.equal(output.exitCode, 0);
  const timeout = await runVerificationProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 });
  assert.equal(timeout.timedOut, true);
  const overflow = await runVerificationProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], { maxOutput: 100 });
  assert.equal(overflow.overflow, true);
  assert.ok(overflow.stdout.length <= 100);
});

test("one-hour review default supports explicit timeout and cancellation callback", async () => {
  assert.equal(REVIEW_TIMEOUT_MS, 3600000);
  let interrupted = false;
  await assert.rejects(withReviewTimeout(() => new Promise(() => {}), 10, () => { interrupted = true; }), /time budget/);
  assert.equal(interrupted, true);
  assert.equal(await withReviewTimeout(() => 42, 100), 42);
});

test("native review timeout interrupts and closes the isolated app-server", (t) => {
  const cwd = repo(t), bin = makeTempDir();
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  installFakeCodex(bin, "review-hangs");
  const source = `import { runAppServerReview } from ${JSON.stringify(new URL("../plugins/code-review/scripts/lib/codex.mjs", import.meta.url).href)};
    try { await runAppServerReview(process.cwd(), { isolated: true, timeoutMs: 8000, target: { type: 'uncommittedChanges' } }); process.exitCode = 2; }
    catch (error) { console.log(error.message); }`;
  const result = run(process.execPath, ["--input-type=module", "-e", source], { cwd, env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /time budget/);
  const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
  assert.ok(state.lastReviewStart);
  assert.ok(state.lastInterrupt);
});

test("CLI rejects invalid verification opt-in before starting Codex", (t) => {
  const cwd = repo(t), selected = path.join(cwd, "verify.json");
  fs.writeFileSync(selected, JSON.stringify({ ...plan, image: "node:latest" }));
  const script = new URL("../plugins/code-review/scripts/codex-companion.mjs", import.meta.url);
  const result = run(process.execPath, [fileURLToPath(script), "lane-review", "--verify", selected], { cwd, input: "Review code" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pinned/);
});

test("lane verification is opt-in, carries evidence and blocks any failed/stale approval", async () => {
  const passed = { status: "passed", image, commands: [], snapshot: { fingerprint: "same", head: "head", included: ["app.js"], excluded: [] }, cleanup: { status: "cleaned" } };
  const complete = { status: 0, turn: { status: "completed" }, reviewText: "Coverage: app.js read.\nVerification: supplied adapter evidence inspected.\nSAFE to merge with 2 warnings" };
  const request = { cwd: "unused", brief: "unit: test", verificationPlan: plan };
  const ops = { ensureGitRepository: () => {}, runVerification: async () => passed, verificationSnapshot: () => passed.snapshot,
    recordOpulentReview: () => ({ state: "recorded" }), runAppServerReview: async (cwd, opts) => {
      assert.match(opts.target.instructions, /Adapter-observed verification evidence/);
      assert.equal(opts.isolated, true);
      assert.ok(opts.timeoutMs <= REVIEW_TIMEOUT_MS && opts.timeoutMs > 3500000);
      return complete;
    } };
  const result = await executeLaneReviewRun(request, ops);
  assert.equal(result.exitStatus, 0);
  assert.equal(result.payload.verification.status, "passed");
  assert.equal(laneVerdict(result.rendered), "SAFE");
  assert.match(renderStoredJobResult({ kind: "lane-review" }, { rendered: result.rendered, result: result.payload }), /adapter-observed/);
  for (const status of ["failed", "error", "cancelled", "timed-out", "stale", "cleanup-failed"]) {
    const failure = await executeLaneReviewRun(request, { ...ops, runVerification: async () => ({ ...passed, status }), runAppServerReview: () => assert.fail("must not review"), recordOpulentReview: () => assert.fail("must not record") });
    assert.equal(failure.exitStatus, 1);
    assert.equal(laneVerdict(failure.rendered), "unknown");
  }
  const stale = await executeLaneReviewRun(request, { ...ops, runVerification: async () => structuredClone(passed), verificationSnapshot: () => ({ fingerprint: "changed" }), recordOpulentReview: () => assert.fail("stale approval") });
  assert.equal(stale.exitStatus, 1);
  assert.equal(laneVerdict(stale.rendered), "unknown");
  const defaultRun = await executeLaneReviewRun({ cwd: "unused", brief: "npm test should pass" }, { ...ops, runVerification: () => assert.fail("implicit opt-in"), runAppServerReview: async () => complete });
  assert.equal(defaultRun.payload.verification, null);
});

test("status and cancellation surface verification cleanup commands", () => {
  const job = { id: "test", status: "cancelled", verificationStatus: "cancelled", verificationCleanup: { status: "needs-attention", commands: ["exact cleanup command"] } };
  assert.match(renderJobStatusReport(job), /Verification: cancelled/);
  assert.match(renderCancelReport(job), /exact cleanup command/);
});

test("cancel and session-end clean owned snapshots and retain failed-cleanup metadata", (t) => {
  const cwd = repo(t);
  t.after(() => fs.rmSync(resolveStateDir(cwd), { recursive: true, force: true }));
  for (const event of ["cancel", "SessionEnd"]) {
    for (const owned of [true, false]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-verification-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const token = crypto.randomUUID();
      fs.writeFileSync(path.join(root, ".verification-owner"), owned ? token : "foreign");
      const id = `verification-${event}-${owned}`;
      const job = { id, kind: "lane-review", status: "running", sessionId: id, pid: null,
        verificationResources: { root, token, container: null } };
      upsertJob(cwd, job); writeJobFile(cwd, id, job);
      const filename = event === "cancel" ? "codex-companion.mjs" : "session-lifecycle-hook.mjs";
      const args = event === "cancel" ? [event, id, "--json"] : [event];
      const result = run(process.execPath, [fileURLToPath(new URL(`../plugins/code-review/scripts/${filename}`, import.meta.url)), ...args], {
        cwd, input: JSON.stringify({ hook_event_name: event, cwd, session_id: id })
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(root), !owned);
      const recorded = loadState(cwd).jobs.find((j) => j.id === id);
      if (event === "SessionEnd" && owned) assert.equal(recorded, undefined);
      else {
        assert.equal(recorded.status, "cancelled");
        assert.equal(recorded.verificationCleanup.status, owned ? "cleaned" : "needs-attention");
      }
    }
  }
});

test("optional live local Docker smoke test", { skip: !process.env.CODEX_VERIFICATION_TEST_IMAGE }, async (t) => {
  const cwd = repo(t);
  const report = await runVerification({ cwd, plan: { schema: "codex-verification/1", image: process.env.CODEX_VERIFICATION_TEST_IMAGE,
    commands: [{ argv: ["/bin/sh", "-c", "test -r /workspace/app.js && ! touch /workspace/forbidden && touch /scratch/ok && test ! -e /workspace/.git"], timeoutSeconds: 30 }] } });
  assert.equal(report.status, "passed", renderVerificationReport(report));
  assert.equal(fs.existsSync(path.join(cwd, "forbidden")), false);
});
