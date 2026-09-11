# Upstream provenance

This project is a fork of OpenAI's
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) at commit
`db52e28f4d9ded852ab3942cea316258ae4ef346`.

The original Apache-2.0 license and NOTICE are retained in
`plugins/code-review`. This fork now keeps only a minimal reviewer subagent, one
review command and a setup command, driving `codex review` directly. The upstream
app-server integration, adversarial review, rescue, status, result, transfer and
cancel capabilities have been removed.
