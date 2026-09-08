// Optional integration against a real Opulent checkout; never import/copy its
// code into the plugin. All hook logs and ledger writes go to temporary roots.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { routingOutput } from "../plugins/code-review/scripts/lib/review-routing.mjs";
import { recordOpulentReview } from "../plugins/code-review/scripts/lib/lane-review.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const reference = process.env.OPULENT_REFERENCE;
const python = process.env.OPULENT_PYTHON;
const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/code-review");

test("real Opulent hooks and ledger renderer accept the substituted review lane", {
  skip: !reference || !python ? "Set OPULENT_REFERENCE and OPULENT_PYTHON to test a local Opulent checkout." : false
}, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(reference, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "opulent");
  const sessionSource = fs.readFileSync(path.join(reference, "hooks", "session-start.py"), "utf8");
  assert.ok(sessionSource.includes("opulent:reviewer"));
  for (const provider of ["opulent:reviewer", "foreign:audit", "code-review:reviewer"]) {
    const cwd = makeTempDir();
    fs.mkdirSync(path.join(cwd, ".claude"));
    fs.writeFileSync(path.join(cwd, ".claude", "pr-lane.json"), JSON.stringify({ schema: "pr-lane/1", review: { provider } }));
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd, OPULENT_LOG: path.join(cwd, "opulent-log.jsonl"), PYTHONDONTWRITEBYTECODE: "1", CODEX_COMPANION_SESSION_ID: "test-session" };
    const input = { subagent_type: provider, prompt: "PR-LANE CONTRACT v1\nunit: codex-compat\nReview main...HEAD. Hazards: concurrency.", description: "Review unit" };
    const payload = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: input, cwd, session_id: "test-session" };
    const before = run(python, ["-B", path.join(reference, "hooks", "route-models.py")], { cwd, env, input: JSON.stringify(payload) });
    assert.equal(before.status, 0, before.stderr);
    const rewritten = routingOutput(payload, plugin, env)?.hookSpecificOutput.updatedInput || input;
    assert.equal(rewritten.subagent_type, "code-review:reviewer");
    recordOpulentReview(cwd, input.prompt, "NOT SAFE", { env });
    const after = run(python, ["-B", path.join(reference, "hooks", "route-models.py")], { cwd, env, input: JSON.stringify({
      ...payload, hook_event_name: "PostToolUse", tool_input: rewritten,
      tool_response: "Critical: A lock race.\nNOT SAFE with 1 Critical finding and 3 warnings"
    }) });
    assert.equal(after.status, 0, after.stderr);
    const lines = fs.readFileSync(path.join(cwd, ".claude", "pr-lane", "ledger.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
    const reviews = lines.filter((line) => line.event === "reviewed");
    assert.equal(reviews.length, 1, `Exactly one reviewed event for provider ${provider}`);
    assert.equal(reviews[0].unit, "codex-compat");
    assert.equal(reviews[0].verdict, "NOT SAFE");
    const report = run(python, ["-B", path.join(reference, "hooks", "pr_lane.py"), cwd], { cwd, env });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /codex-compat/);
    assert.match(report.stdout, /NOT SAFE/);
  }
});
