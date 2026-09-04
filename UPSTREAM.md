# Upstream provenance

This project is a fork of OpenAI's
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) at commit
`db52e28f4d9ded852ab3942cea316258ae4ef346`.

The original Apache-2.0 license and NOTICE are retained in
`plugins/code-review`. The fork changes the marketplace and plugin identity,
adds a drop-in `/code-review` command, and adds an isolated GitHub pull-request
review and commenting workflow. The upstream review, adversarial review,
rescue, setup, status, result, transfer, and cancel capabilities remain
available under the `/code-review:*` namespace.
