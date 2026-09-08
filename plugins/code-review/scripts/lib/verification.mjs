import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { REVIEW_TIMEOUT_MS } from "./review-timeout.mjs";

const OWNER_FILE = ".verification-owner";
const MAX_OUTPUT = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 50000;
const LABEL = "dev.codex-code-review.verification";
const credentialPart = /^(?:\.git|\.codex|\.ssh|\.aws|\.docker|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials)$/i;

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function relativePath(value, allowDot = false) {
  if (allowDot && value === ".") return value;
  if (typeof value !== "string" || !value || value.length > 250 || /[\\,:\x00-\x1f]/.test(value)
    || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || credentialPart.test(part))) {
    throw new Error(`Unsafe verification-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseVerificationPlan(raw) {
  if (!raw || Array.isArray(raw) || raw.schema !== "codex-verification/1") throw new Error("Expected verification plan schema codex-verification/1.");
  for (const key of Object.keys(raw)) if (!["schema", "image", "commands", "writablePaths"].includes(key)) throw new Error(`Unknown verification plan key: ${key}`);
  if (typeof raw.image !== "string" || !/^(?:[a-z0-9][a-z0-9._/:~-]*@)?sha256:[a-f0-9]{64}$/.test(raw.image)) {
    throw new Error("Verification requires a locally available image pinned by sha256 digest or image ID; tags are not accepted.");
  }
  if (!Array.isArray(raw.commands) || raw.commands.length < 1 || raw.commands.length > 8) throw new Error("Select between one and eight verification commands explicitly.");
  const commands = raw.commands.map((item) => {
    if (!item || Array.isArray(item) || Object.keys(item).some((key) => !["argv", "cwd", "timeoutSeconds"].includes(key))) throw new Error("Invalid verification command fields.");
    if (!Array.isArray(item.argv) || item.argv.length < 1 || item.argv.length > 64
      || item.argv.some((arg) => typeof arg !== "string" || arg.length > 8192 || /[\x00\r\n]/.test(arg))
      || !item.argv[0] || item.argv[0].startsWith("-")) throw new Error("Verification commands must be nonempty argument arrays, not shell command strings.");
    const timeoutSeconds = item.timeoutSeconds ?? REVIEW_TIMEOUT_MS / 1000;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error("Command timeoutSeconds must be between 1 and 3600.");
    return { argv: [...item.argv], cwd: relativePath(item.cwd ?? ".", true), timeoutSeconds };
  });
  const writablePaths = raw.writablePaths ?? [];
  if (!Array.isArray(writablePaths) || writablePaths.length > 8) throw new Error("At most eight temporary writable output directories are allowed.");
  writablePaths.forEach((value) => relativePath(value));
  if (new Set(writablePaths).size !== writablePaths.length || writablePaths.some((a) => writablePaths.some((b) => a !== b && a.startsWith(`${b}/`)))) throw new Error("Writable paths must not overlap.");
  return { schema: raw.schema, image: raw.image, commands, writablePaths: [...writablePaths] };
}

export function cleanVerificationEnvironment(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (["path", "systemroot", "windir", "temp", "tmp"].includes(key.toLowerCase())) clean[key] = value;
  }
  // No auth tokens, SSH agents, Docker overrides, Git config or user-home env.
  return clean;
}

function executable(name, cwd) {
  const envPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try {
      const resolved = fs.realpathSync(candidate);
      if (!inside(cwd, resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch { /* Next PATH entry. */ }
  }
  throw new Error(`${name} is unavailable outside the reviewed checkout. Verification never falls back to host test execution.`);
}

function gitOutput(cwd, args) {
  const result = spawnSync(executable("git", cwd), ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, shell: false, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    env: { ...cleanVerificationEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull }
  });
  if (result.error || result.status !== 0) throw new Error(`Verification snapshot Git check failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

export function verificationSnapshot(cwd, destination = null, deadline = Date.now() + REVIEW_TIMEOUT_MS) {
  const root = fs.realpathSync(gitOutput(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = gitOutput(root, ["rev-parse", "HEAD"]).trim();
  const index = gitOutput(root, ["ls-files", "--stage", "-z"]);
  const modes = new Map();
  for (const row of index.split("\0").filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(row);
    if (!match || match[2] !== "0") throw new Error("Verification does not support unresolved index conflicts.");
    if (["120000", "160000"].includes(match[1])) throw new Error("Verification snapshots do not follow symlinks or submodules.");
    modes.set(match[3], match[1]);
  }
  const files = [...new Set(gitOutput(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
  if (files.length > MAX_FILES) throw new Error("Verification snapshot exceeds the 50,000-file limit.");
  const hash = crypto.createHash("sha256").update(head).update(index);
  const included = [], excluded = [];
  let bytes = 0;
  for (const relative of files) {
    if (Date.now() >= deadline) throw new Error("Verification snapshot time budget exhausted.");
    if (relative.split("/").some((part) => credentialPart.test(part))) { excluded.push(relative); continue; }
    relativePath(relative);
    const source = path.resolve(root, relative);
    if (!inside(root, source)) throw new Error("Verification snapshot escaped the checkout.");
    try { fs.lstatSync(source); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update(`deleted:${relative}\0`); continue;
    }
    let ancestor = root;
    for (const part of relative.split("/")) {
      ancestor = path.join(ancestor, part);
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Verification refuses symbolic links: ${relative}`);
    }
    if (!inside(root, fs.realpathSync(source)) || !fs.statSync(source).isFile()) throw new Error(`Unsupported snapshot entry: ${relative}`);
    bytes += fs.statSync(source).size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Verification snapshot exceeds the 256 MiB source limit; ignored dependencies are not copied.");
    const buffer = fs.readFileSync(source);
    hash.update(relative).update("\0").update(buffer).update("\0");
    included.push(relative);
    if (destination) {
      const target = path.join(destination, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer, { mode: modes.get(relative) === "100755" || (fs.statSync(source).mode & 0o111) ? 0o755 : 0o644 });
    }
  }
  return { root, head, fingerprint: hash.digest("hex"), included, excluded, bytes };
}

export function runVerificationProcess(binary, args, { cwd, env, timeoutMs = 10000, signal, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false, aborted = false;
    const abort = () => { aborted = true; child.kill(); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(1, timeoutMs));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutput) { overflow = true; child.kill(); return; }
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const finish = (exitCode, error = null) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      resolve({ exitCode, stdout, stderr, timedOut, overflow, aborted, error, elapsedMs: Date.now() - start });
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

function successful(result) { return result.exitCode === 0 && !result.error && !result.timedOut && !result.overflow && !result.aborted; }
function localHost(host) { return typeof host === "string" && !/[\r\n\x00]/.test(host) && (/^unix:\/\/\/[^\x00]+$/.test(host) || /^npipe:\/{2,4}\.\/pipe\/[a-z0-9_.-]+$/i.test(host)); }
function dockerArgs(resources, args) { return ["--config", path.join(resources.root, "docker-config"), "--host", resources.host, ...args]; }
function shellDisplay(binary, args) {
  const quote = (value) => process.platform === "win32" ? `'${String(value).replace(/'/g, "''")}'` : `'${String(value).replace(/'/g, `'"'"'`)}'`;
  return `${process.platform === "win32" ? "& " : ""}${[binary, ...args].map(quote).join(" ")}`;
}

function assertOwned(resources) {
  if (!resources || !/^codex-verification-[a-zA-Z0-9]+$/.test(path.basename(resources.root))
    || path.resolve(path.dirname(resources.root)) !== path.resolve(os.tmpdir())
    || !/^[a-f0-9-]{36}$/.test(resources.token) || fs.lstatSync(resources.root).isSymbolicLink()
    || fs.readFileSync(path.join(resources.root, OWNER_FILE), "utf8") !== resources.token) throw new Error("Refusing cleanup of an unowned verification directory.");
}

export async function cleanupVerification(resources, operations = {}) {
  if (!resources) return { status: "not-needed", commands: [] };
  const commands = [];
  let owned = false;
  try {
    if (!fs.existsSync(resources.root)) {
      if (resources.container) throw new Error("Verification ownership directory is missing; container cleanup cannot be confirmed.");
      return { status: "cleaned", commands };
    }
    assertOwned(resources);
    owned = true;
    if (resources.container) {
      if (!localHost(resources.host) || resources.container !== `codex-verify-${resources.token}` || !/[\\/]docker(?:\.exe)?$/i.test(resources.docker)) throw new Error("Invalid verification container identity.");
      const run = operations.run ?? runVerificationProcess;
      const options = { cwd: resources.root, env: cleanVerificationEnvironment(), timeoutMs: 5000 };
      const inspect = await run(resources.docker, dockerArgs(resources, ["inspect", "--format", "{{json .Config.Labels}}", resources.container]), options);
      if (successful(inspect)) {
        if (JSON.parse(inspect.stdout)?.[LABEL] !== resources.token) throw new Error("Verification container ownership label mismatch.");
        const args = dockerArgs(resources, ["rm", "--force", "--volumes", resources.container]);
        commands.push(shellDisplay(resources.docker, args));
        const removed = await run(resources.docker, args, options);
        if (!successful(removed)) throw new Error(`Container cleanup failed: ${removed.error || removed.stderr}`);
      } else if (!/No such (?:object|container)/i.test(inspect.stderr)) {
        commands.push(shellDisplay(resources.docker, dockerArgs(resources, ["rm", "--force", "--volumes", resources.container])));
        throw new Error(`Could not confirm container cleanup: ${inspect.error || inspect.stderr}`);
      }
    }
    // root was checked against the exact temp parent and the private ownership
    // marker. Node removes nested symlinks themselves, never their targets.
    fs.rmSync(resources.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { status: "cleaned", commands: [] };
  } catch (error) {
    if (owned) commands.push(process.platform === "win32"
      ? `Remove-Item -LiteralPath '${String(resources.root).replace(/'/g, "''")}' -Recurse -Force`
      : `rm -rf -- '${String(resources.root).replace(/'/g, `'"'"'`)}'`);
    return { status: "needs-attention", error: error.message, commands };
  }
}

export function containerCreateArgs(plan, resources, snapshot, remainingMs) {
  if (/[",\r\n]/.test(resources.root)) throw new Error("Temporary directory contains unsupported Docker mount characters.");
  const args = ["create", "--name", resources.container, "--label", `${LABEL}=${resources.token}`,
    "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=256", "--memory=4g", "--memory-swap=4g", "--cpus=2", "--no-healthcheck", "--log-driver=none",
    "--user", `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`, "--workdir", "/workspace",
    "--mount", `type=bind,source=${path.join(resources.root, "source")},target=/workspace,readonly`,
    "--tmpfs", "/scratch:rw,exec,nosuid,nodev,size=2g,mode=1777", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
    "--env", "HOME=/scratch", "--env", "CARGO_TARGET_DIR=/scratch/target", "--env", "npm_config_cache=/scratch/npm-cache",
    "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "CI=true"];
  for (const relative of plan.writablePaths) {
    if (snapshot.included.some((file) => file === relative || file.startsWith(`${relative}/`) || relative.startsWith(`${file}/`))) throw new Error(`Writable output path would hide source: ${relative}`);
    fs.mkdirSync(path.join(resources.root, "source", relative), { recursive: true });
    args.push("--tmpfs", `/workspace/${relative}:rw,exec,nosuid,nodev,size=512m,mode=1777`);
  }
  // A sleeping PID 1 keeps tmpfs outputs between exec calls and normally bounds
  // container lifetime after a hard kill. It is not a watchdog against hostile
  // commands interfering with PID 1. The selected image must provide /bin/sleep.
  args.push("--entrypoint", "/bin/sleep", plan.image, String(Math.max(1, Math.ceil(remainingMs / 1000))));
  return args;
}

export async function runVerification(request, operations = {}) {
  const plan = parseVerificationPlan(request.plan);
  const run = operations.run ?? runVerificationProcess;
  const snapshotFn = operations.snapshot ?? verificationSnapshot;
  const deadline = request.deadline ?? Date.now() + REVIEW_TIMEOUT_MS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-verification-"));
  const resources = { root, token: crypto.randomUUID(), host: null, docker: null, container: null };
  const report = { status: "error", image: plan.image, commands: [], snapshot: null, cleanup: null };
  fs.writeFileSync(path.join(root, OWNER_FILE), resources.token, { mode: 0o600 });
  const update = (patch) => request.onUpdate?.(patch);
  try {
    update({ verificationStatus: "preparing", verificationResources: { ...resources } });
    const docker = operations.docker ?? executable("docker", request.cwd);
    resources.docker = docker;
    fs.mkdirSync(path.join(root, "docker-config"));
    // Read only the active endpoint, never pass the user's Docker config or
    // credentials to a container. Remote daemons are explicitly rejected.
    const context = await run(docker, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], {
      cwd: root, env: { ...cleanVerificationEnvironment(), HOME: os.homedir(), USERPROFILE: os.homedir() }, timeoutMs: 10000, signal: request.signal
    });
    if (!successful(context)) throw new Error(`Local Docker context is unavailable: ${context.error || context.stderr}`);
    resources.host = JSON.parse(context.stdout.trim());
    if (!localHost(resources.host)) throw new Error("Verification requires a local Unix-socket or named-pipe Docker daemon; remote endpoints are rejected.");
    const invoke = async (args, timeoutMs = 10000) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || request.signal?.aborted) throw new Error("Verification time budget exhausted or cancelled.");
      return run(docker, dockerArgs(resources, args), { cwd: root, env: cleanVerificationEnvironment(), timeoutMs: Math.min(timeoutMs, remaining), signal: request.signal });
    };
    const info = await invoke(["info", "--format", "{{.OSType}}"]);
    if (!successful(info) || info.stdout.trim() !== "linux") throw new Error("Verification requires a running Linux-container Docker daemon.");
    const image = await invoke(["image", "inspect", plan.image]);
    if (!successful(image)) throw new Error("Pinned verification image is not available locally. Build or load it explicitly; the plugin never pulls images.");
    const imageConfig = JSON.parse(image.stdout)[0]?.Config;
    if (!imageConfig || Object.keys(imageConfig.Volumes || {}).length) throw new Error("Verification images must not declare VOLUME mounts; only bounded temporary output mounts are permitted.");
    fs.mkdirSync(path.join(root, "source"));
    report.snapshot = snapshotFn(request.cwd, path.join(root, "source"), deadline);
    resources.container = `codex-verify-${resources.token}`;
    update({ verificationStatus: "running", verificationResources: { ...resources } });
    const created = await invoke(containerCreateArgs(plan, resources, report.snapshot, deadline - Date.now()));
    if (!successful(created)) throw new Error(`Cannot create verification container: ${created.error || created.stderr}`);
    const started = await invoke(["start", resources.container]);
    if (!successful(started)) throw new Error(`Cannot start verification container: ${started.error || started.stderr}`);
    for (const [index, command] of plan.commands.entries()) {
      request.onProgress?.({ phase: "verifying", message: `Verification command ${index + 1}/${plan.commands.length}: ${JSON.stringify(command.argv)}` });
      const result = await invoke(["exec", "--workdir", command.cwd === "." ? "/workspace" : `/workspace/${command.cwd}`, resources.container, ...command.argv], command.timeoutSeconds * 1000);
      report.commands.push({ ...command, ...result });
      update({ verificationStatus: successful(result) ? "running" : "failed", verificationReport: report });
      if (!successful(result)) { report.status = result.timedOut ? "timed-out" : result.aborted ? "cancelled" : "failed"; break; }
    }
    if (report.commands.length === plan.commands.length && report.commands.every(successful)) report.status = "passed";
    if (snapshotFn(request.cwd, null, deadline).fingerprint !== report.snapshot.fingerprint) {
      report.status = "stale"; report.error = "Checkout changed during verification; test evidence is stale.";
    }
  } catch (error) {
    if (report.status === "passed") report.status = "error";
    report.error = error.message;
  } finally {
    report.cleanup = await cleanupVerification(resources, { run });
    if (report.cleanup.status === "needs-attention") report.status = "cleanup-failed";
    update({ verificationStatus: report.status, verificationReport: report, verificationCleanup: report.cleanup,
      verificationResources: report.cleanup.status === "needs-attention" ? resources : null });
  }
  return report;
}

export function renderVerificationReport(report) {
  const lines = [`Verification (adapter-observed): ${report.status}. Image: ${report.image}`];
  if (report.snapshot) lines.push(`Snapshot: HEAD ${report.snapshot.head}; SHA-256 ${report.snapshot.fingerprint}; ${report.snapshot.included.length} included files. Excluded: ${report.snapshot.excluded.join(", ") || "none"}. Ignored files and host dependencies were not copied.`);
  for (const command of report.commands) lines.push(`Command ${JSON.stringify(command.argv)} in ${command.cwd}: exit ${command.exitCode}; ${command.elapsedMs} ms${command.timedOut ? "; timed out" : ""}${command.overflow ? "; output limit exceeded" : ""}\n${(command.stdout + command.stderr).slice(0, 8000)}`);
  if (report.error) lines.push(report.error);
  if (report.cleanup?.status === "needs-attention") lines.push(`Cleanup requires attention: ${report.cleanup.error || "removal failed"}`, ...report.cleanup.commands);
  return lines.join("\n");
}
