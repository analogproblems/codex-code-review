#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { routingOutput } from "./lib/review-routing.mjs";

try {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const output = routingOutput(payload, fileURLToPath(new URL("..", import.meta.url)));
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  // A broken routing hook must be visible; it must not silently claim takeover.
  process.stderr.write(`Codex review routing failed: ${error.message}\n`);
  process.exitCode = 2;
}
