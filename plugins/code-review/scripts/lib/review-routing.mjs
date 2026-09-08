import fs from "node:fs";
import path from "node:path";

export const REVIEWER = "code-review:reviewer";

export const REVIEW_POLICY = `Codex code-review routing is enabled. For ALL code reviews, including Opulent's mandatory before-done/before-merge review lane, use Agent with subagent_type "${REVIEWER}". Claude orchestrates; Codex performs the review. This replaces opulent:reviewer and any PR-lane review.provider for this session only. Keep Opulent's architect, coder, mechanic, test-runner, permissions, unit contracts, review-round limits and merge decisions unchanged.
Forward the complete review brief verbatim: repository/worktree, commit range or base branch, unit: line, hazards, checks, rationale and previous findings/delta. Do not review code yourself or substitute another Claude reviewer, even if Codex fails. Report the failure and leave the review outstanding; use /code-review:setup for readiness problems.
The reviewer agent runs a local read-only Codex review and does NOT post to GitHub. Use /code-review only for the explicit GitHub PR-comment workflow; /code-review:review and /code-review:adversarial-review remain available for their existing Codex workflows. Do not use rescue/task for code reviews.
For Workflow/ultracode agent() calls, select agentType "${REVIEWER}" and do not pin the former Opus reviewer model/effort. Prefer the standard Agent tool so routing hooks are observed. A launched/background job is not a completed review. Wait for the Codex result before declaring the unit reviewed or safe. Do not add a second review merely because the provider changed.`;

// Match review roles, not arbitrary requests containing the word "review".
// Non-code review skills (e.g. document review) are intentionally unaffected.
export function isReviewAgent(name, provider = null) {
  if (typeof name !== "string" || !name) return false;
  if (name === provider) return true;
  return [REVIEWER, "opulent:reviewer", "reviewer"].includes(name)
    || /(?:^|:)(?:code-reviewer|code-review|security-reviewer|test-reviewer)$/.test(name);
}

export function opulentProject(cwd, env = process.env) {
  let value = env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  if (process.platform === "win32") value = value.replace(/^\/([a-z])\//i, "$1:/");
  return path.resolve(value);
}

export function readOpulentConfig(cwd, env = process.env) {
  const project = opulentProject(cwd, env);
  try {
    const config = JSON.parse(fs.readFileSync(path.join(project, ".claude", "pr-lane.json"), "utf8"));
    if (!config || Array.isArray(config) || config.schema !== "pr-lane/1") return null;
    let provider = config.review?.provider;
    if (typeof provider !== "string" || ["opulent:coder", "opulent:mechanic"].includes(provider)) {
      provider = "opulent:reviewer";
    }
    return { project, provider: provider.trim().replace(/\s+/g, " ") };
  } catch {
    return null; // Absent/malformed/unknown-schema PR lane stays inert, as in Opulent.
  }
}

export function routingOutput(payload, pluginRoot, env = process.env) {
  const event = payload.hook_event_name;
  const context = (additionalContext) => ({ hookSpecificOutput: { hookEventName: event, additionalContext } });
  if (event === "SessionStart" || event === "UserPromptSubmit") return context(`${REVIEW_POLICY}\nDocumentation/runbook passes may be delegated separately; they do not replace the Codex code gate.`);

  // Claude uses the entire command as the background-task label when Bash has
  // no description. Keep heredoc briefs out of that label without changing the
  // command or granting permissions. Only our review invocation is in scope.
  if (event === "PreToolUse" && payload.tool_name === "Bash") {
    const input = payload.tool_input;
    const firstLine = typeof input?.command === "string" ? input.command.split(/\r?\n/, 1)[0] : "";
    if (!/codex-companion\.mjs["']?\s+lane-review(?:\s|$)/.test(firstLine)) return null;
    if (typeof input.description === "string" && input.description.trim() && input.description.length <= 80 && !/[\r\n]/.test(input.description)) return null;
    return { hookSpecificOutput: { hookEventName: event, updatedInput: { ...input, description: "Codex review" } } };
  }

  const provider = readOpulentConfig(payload.cwd, env)?.provider;
  if (event === "SubagentStart" && isReviewAgent(payload.agent_type, provider)) {
    return context(`${REVIEW_POLICY}\nYou are a forwarding wrapper, not a Claude reviewer. Run node with the absolute script path ${JSON.stringify(path.join(pluginRoot, "scripts", "codex-companion.mjs"))} and the lane-review subcommand. Set Bash description to "Codex review" (never the brief) and run_in_background to true, then wait through polling timeouts for the one-hour review budget. Send the full brief, scope, unit, hazards, checks and previous findings literally via stdin using a single-quoted heredoc with a delimiter absent from the brief (or a prompt file); never interpolate it into shell arguments. Add --verify only with explicit user consent and a selected plan; no host test execution. Wait for completion, return stdout verbatim, and surface nonzero exits. Do not inspect code, fix it, post to GitHub, delegate another review, or invent a verdict. Codex failure leaves the review outstanding; no Claude fallback. Preserve Opulent's review rounds and merge decisions.`);
  }
  if (event !== "PreToolUse" || !["Agent", "Task"].includes(payload.tool_name)) return null;
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !isReviewAgent(input.subagent_type, provider)) return null;
  if (input.subagent_type === REVIEWER) return null;
  if (input.resume) {
    return { hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: "deny",
      permissionDecisionReason: `Cannot resume a Claude reviewer as a Codex review. Start ${REVIEWER} with a complete brief, explicitly including the previous findings and requested delta; preserve the existing review round.`
    } };
  }
  const updatedInput = { ...input, subagent_type: REVIEWER };
  delete updatedInput.model;
  delete updatedInput.effort;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      updatedInput,
      additionalContext: `Routed ${input.subagent_type} to ${REVIEWER}. The full brief is unchanged. ${REVIEW_POLICY}`
      // No permissionDecision: routing must not grant tool permissions.
    }
  };
}
