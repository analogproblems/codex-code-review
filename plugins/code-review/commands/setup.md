---
description: Check whether Codex is installed and authenticated
allowed-tools: Bash(codex:*), Bash(npm:*), AskUserQuestion
---

Check the Codex CLI:

```bash
codex --version
codex login status
```

If `codex --version` fails and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun the two checks above.

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Report the Codex version and login status to the user.
- If installation was skipped, say that reviews will fail until Codex is installed.
- If Codex is installed but not authenticated, tell the user to run `!codex login`.
