import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = pathToFileURL(path.join(ROOT, "plugins/code-review/scripts/lib/codex.mjs")).href;

for (const override of [false, true]) {
  test(`native review uses Astra low defaults and respects explicit overrides: ${override}`, () => {
    const cwd = makeTempDir();
    const bin = makeTempDir();
    installFakeCodex(bin);
    const options = override ? { model: "gpt-5.4", effort: "high" } : {};
    const result = run(process.execPath, ["--input-type=module", "-e", `
      import { runAppServerReview } from ${JSON.stringify(runtime)};
      await runAppServerReview(process.cwd(), { target: { type: 'uncommittedChanges' }, isolated: true, ...${JSON.stringify(options)} });
    `], { cwd, env: buildEnv(bin) });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
    assert.equal(state.lastThreadStart.model, override ? "gpt-5.4" : "gpt-6-astra");
    assert.deepEqual(state.lastThreadStart.config, {
      model_reasoning_effort: override ? "high" : "low",
      review_model: override ? "gpt-5.4" : "gpt-6-astra"
    });
    assert.equal(state.lastThreadStart.sandbox, "read-only");
    assert.equal(state.lastThreadStart.approvalPolicy, "never");
    assert.equal(state.lastTurnStart, undefined);
    assert.equal(state.lastReviewStart.target.type, "uncommittedChanges");
  });

  test(`fresh and resumed task turns use Astra low defaults and respect explicit overrides: ${override}`, () => {
    const cwd = makeTempDir();
    const bin = makeTempDir();
    installFakeCodex(bin);
    const options = override ? { model: "gpt-5.4", effort: "high" } : {};
    const result = run(process.execPath, ["--input-type=module", "-e", `
      import { runAppServerTurn } from ${JSON.stringify(runtime)};
      const options = { prompt: 'Read-only test', persistThread: true, ...${JSON.stringify(options)} };
      const first = await runAppServerTurn(process.cwd(), options);
      await runAppServerTurn(process.cwd(), { ...options, resumeThreadId: first.threadId });
    `], { cwd, env: { ...buildEnv(bin), CODEX_COMPANION_SESSION_ID: "", CLAUDE_PLUGIN_DATA: path.join(bin, "data") } });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8"));
    for (const params of [state.lastThreadStart, state.lastThreadResume]) {
      assert.equal(params.model, override ? "gpt-5.4" : "gpt-6-astra");
      assert.deepEqual(params.config, { model_reasoning_effort: override ? "high" : "low" });
    }
    assert.equal(state.lastTurnStart.model, override ? "gpt-5.4" : "gpt-6-astra");
    assert.equal(state.lastTurnStart.effort, override ? "high" : "low");
  });
}
