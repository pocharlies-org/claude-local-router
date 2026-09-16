---
description: Re-read the router's gateway URL and key from its env file without dropping the listener
allowed-tools: Bash(pgrep:*), Bash(kill:*), Bash(curl:*), Bash(awk:*)
---

# Router reload

`claude-router` re-reads `~/.config/claude-local/env` on `SIGHUP`, so a rotated gateway key
or a changed gateway URL applies **without restarting** — in-flight streams survive.

1. Find it: `pgrep -af claude-router.js`
2. Signal it: `kill -HUP <pid>`
3. Confirm it took: `curl -fsS -m 5 "http://127.0.0.1:${CLAUDE_ROUTER_PORT:-18791}/-/health"`
   and check `litellm` now names the new host.

The reload line lands in the log (`~/Library/Logs/claude-router.log` on macOS,
`journalctl --user -u claude-router` on Linux) and reads `reload ok litellm=<host>` or
`reload ERROR <msg>`. Report which one you got — a malformed env file fails the reload and
leaves the **old** config running, which looks like the edit was ignored.

$ARGUMENTS
