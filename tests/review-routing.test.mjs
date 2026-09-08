import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { routingOutput, REVIEW_POLICY, REVIEW_REMINDER, REVIEWER, readOpulentConfig } from "../plugins/code-review/scripts/lib/review-routing.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "code-review");
const HOOK = path.join(PLUGIN, "scripts", "review-routing-hook.mjs");

test("Bash review task labels stay short while the literal brief and command remain intact", () => {
  const command = 'node "/plugin/scripts/codex-companion.mjs" lane-review <<\'BRIEF\'\nA long complete review brief\nBRIEF';
  for (const description of [undefined, "", "x".repeat(1000), "review\nbrief"]) {
    const input = { command, description, run_in_background: true };
    const output = routingOutput({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: input }, PLUGIN);
    assert.deepEqual(output.hookSpecificOutput.updatedInput, { ...input, description: "Codex review" });
    assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  }
  assert.equal(routingOutput({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "Codex review: D-113" } }, PLUGIN), null);
  assert.equal(routingOutput({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }, PLUGIN), null);
});

test("session and every user prompt establish the Codex review lane without replacing other Opulent lanes", () => {
  assert.ok(routingOutput({ hook_event_name: "SessionStart" }, PLUGIN).hookSpecificOutput.additionalContext.startsWith(REVIEW_POLICY));
  assert.equal(routingOutput({ hook_event_name: "UserPromptSubmit" }, PLUGIN).hookSpecificOutput.additionalContext, REVIEW_REMINDER);
  assert.ok(REVIEW_REMINDER.length < REVIEW_POLICY.length / 4);
  assert.match(REVIEW_POLICY, /ALL code reviews/);
  assert.match(REVIEW_POLICY, /Keep Opulent's architect, coder, mechanic, test-runner, permissions/);
  assert.match(REVIEW_POLICY, /Do not review code yourself/);
  assert.match(REVIEW_POLICY, /Workflow\/ultracode/);
  assert.match(REVIEW_POLICY, /does NOT post to GitHub/);
});

test("Opulent and other code-review agents are redirected without mutating their briefs or granting permissions", () => {
  const cwd = makeTempDir();
  for (const tool_name of ["Agent", "Task"]) {
    for (const subagent_type of ["opulent:reviewer", "superpowers:code-reviewer", "pr-review-toolkit:code-reviewer", "reviewer"]) {
      const input = { subagent_type, prompt: 'unit: issue-12\nReview main...HEAD; $(touch OWNED) `echo nope`\nHazards: auth',
        description: "Review unit", model: "opus", effort: "high",
        run_in_background: true, isolation: "worktree", name: "unit-review" };
      const original = structuredClone(input);
      const output = routingOutput({ hook_event_name: "PreToolUse", tool_name, tool_input: input, cwd }, PLUGIN, {});
      const { model, effort, ...preserved } = original;
      assert.deepEqual(output.hookSpecificOutput.updatedInput, { ...preserved, subagent_type: REVIEWER });
      assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
      assert.ok(output.hookSpecificOutput.additionalContext.length < REVIEW_POLICY.length / 4);
      assert.deepEqual(input, original);
    }
  }
});

test("resuming a foreign reviewer is blocked until the previous findings are supplied explicitly", () => {
  const output = routingOutput({ hook_event_name: "PreToolUse", tool_name: "Agent", cwd: makeTempDir(),
    tool_input: { subagent_type: "opulent:reviewer", resume: "old-agent", prompt: "Recheck those findings" } }, PLUGIN, {});
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /previous findings/);
  assert.equal(output.hookSpecificOutput.updatedInput, undefined);
});

test("non-review lanes, already-Codex routing and unrelated tools are untouched, including inside subagents", () => {
  const cwd = makeTempDir();
  for (const subagent_type of [REVIEWER, "opulent:coder", "opulent:mechanic", "opulent:test-runner", "Explore", "Plan", "code-review:codex-rescue", "documents:review", null, {}, []]) {
    assert.equal(routingOutput({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type, prompt: "Review the code" }, cwd, agent_id: "child" }, PLUGIN, {}), null);
  }
  for (const tool_name of ["Bash", "Write", "Skill"]) {
    assert.equal(routingOutput({ hook_event_name: "PreToolUse", tool_name, tool_input: { subagent_type: "opulent:reviewer" }, cwd }, PLUGIN, {}), null);
  }
  assert.equal(routingOutput({ hook_event_name: "SubagentStart", agent_type: "opulent:coder", cwd }, PLUGIN, {}), null);
});

test("reviewer SubagentStart injects the absolute runtime path and no-Claude-fallback contract", () => {
  const output = routingOutput({ hook_event_name: "SubagentStart", agent_type: "opulent:reviewer", cwd: makeTempDir() }, PLUGIN, {});
  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(JSON.stringify(path.join(PLUGIN, "scripts", "codex-companion.mjs"))));
  assert.match(context, /lane-review/);
  assert.match(context, /return stdout verbatim/);
  assert.match(context, /never interpolate it into shell arguments/);
  assert.equal(context.includes(REVIEW_POLICY), false);
  assert.match(context, /one-hour review budget/);
  assert.match(context, /explicit user consent and a selected plan/);
});

test("an opted-in custom Opulent review provider is replaced without editing config", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, ".claude"));
  const configPath = path.join(cwd, ".claude", "pr-lane.json");
  const content = JSON.stringify({ schema: "pr-lane/1", review: { provider: "external:audit" } });
  fs.writeFileSync(configPath, content);
  const output = routingOutput({ hook_event_name: "PreToolUse", tool_name: "Agent", cwd,
    tool_input: { subagent_type: "external:audit", prompt: "unit: 1" } }, PLUGIN, {});
  assert.equal(output.hookSpecificOutput.updatedInput.subagent_type, REVIEWER);
  assert.equal(fs.readFileSync(configPath, "utf8"), content);
  for (const invalid of ["{", "[]", '{"schema":"pr-lane/2"}']) {
    fs.writeFileSync(configPath, invalid);
    assert.equal(readOpulentConfig(cwd, {}), null);
  }
});

test("routing hook emits parseable JSON, stays silent for non-review tools, and surfaces corrupt input", () => {
  const cwd = makeTempDir();
  const result = run(process.execPath, [HOOK], { cwd, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Agent", cwd,
    tool_input: { subagent_type: "opulent:reviewer", prompt: "unit: test" } }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.subagent_type, REVIEWER);
  const noop = run(process.execPath, [HOOK], { cwd, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }) });
  assert.equal(noop.stdout, "");
  const invalid = run(process.execPath, [HOOK], { cwd, input: "{" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Codex review routing failed/);
});

test("plugin registers routing hooks and a Bash-only forwarding reviewer", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "SubagentStart"]) {
    assert.ok(hooks[event].some((group) => group.hooks.some((hook) => hook.command.includes("review-routing-hook.mjs"))));
  }
  const agent = fs.readFileSync(path.join(PLUGIN, "agents", "reviewer.md"), "utf8");
  assert.match(agent, /^model: haiku$/m);
  assert.match(agent, /^tools: Bash$/m);
  assert.match(agent, /Preserve the brief verbatim/);
  assert.match(agent, /do not fall back to a Claude review/);
  assert.match(agent, /lane-review/);
});
