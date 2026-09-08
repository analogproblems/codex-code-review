import fs from "node:fs";
import path from "node:path";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Discover checkout boundaries without first executing a PATH-provided Git.
// Include both lexical and canonical ancestors, and .git files (worktrees).
function checkoutBoundaries(cwd) {
  const roots = new Set();
  for (const start of [path.resolve(cwd), fs.realpathSync(cwd)]) {
    roots.add(start);
    for (let dir = start; ; dir = path.dirname(dir)) {
      try {
        fs.lstatSync(path.join(dir, ".git"));
        roots.add(dir);
        roots.add(fs.realpathSync(dir));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  return [...roots];
}

export function resolveHostExecutable(name, cwd, env = process.env) {
  const roots = checkoutBoundaries(cwd);
  const envPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
  for (const dir of envPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    try {
      const resolved = fs.realpathSync(candidate);
      if (roots.some((root) => inside(root, candidate) || inside(root, resolved))) continue;
      if (!fs.statSync(resolved).isFile()) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch { /* Try the next absolute PATH entry. */ }
  }
  throw new Error(`${name} is unavailable outside the reviewed checkout. Install it on a trusted absolute PATH outside the repository.`);
}
