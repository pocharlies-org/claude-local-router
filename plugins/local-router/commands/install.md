---
description: Deploy (or redeploy) the router that ships inside this plugin
allowed-tools: Bash(bash:*), Bash(curl:*), Bash(pgrep:*), Bash(sha256sum:*), Bash(shasum:*)
---

# Install / redeploy the router

This plugin owns the router: `~/.local/bin/claude-router.js` is placed **only** by the
plugin's `scripts/deploy.sh`, sourced from the binary bundled in the plugin. To change the
router you update the plugin; the SessionStart hook then redeploys it on the next session.

Run the bundled deployer with `--force` (redeploys even if the deployed copy already
matches), then report what it printed:

```sh
bash "$(ls -d "$HOME"/.claude/plugins/cache/claude-local-router/local-router/*/scripts/deploy.sh | sort -V | tail -1)" --force
```

If it reports the env file still has `CHANGEME`, tell the user to fill
`~/.config/claude-local/env` (gateway URL + key) and restart the service — do not invent a
gateway. If it reports the router is not answering, show the service log it names.

$ARGUMENTS
