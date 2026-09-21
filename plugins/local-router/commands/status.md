---
description: Show what the local router is doing right now — routing, counters, and whether anything went to Anthropic that you did not ask for
allowed-tools: Bash(curl:*), Bash(jq:*), Bash(pgrep:*)
---

# Router status

Read the live state of the local `claude-router` proxy and explain it.

Port: `${CLAUDE_ROUTER_PORT:-18791}`. Fetch:

```
curl -fsS -m 5 "http://127.0.0.1:${CLAUDE_ROUTER_PORT:-18791}/-/health"
```

Then report, in this order, **translating rather than dumping** the JSON:

1. **Routing** — `gateway` is the host local models go to; `local_re` is the regex a
   `model` must match to be sent there. Anything not matching goes to Anthropic untouched.
   (`gateway` is the config; `litellm` further down is the *counter* of requests served by
   it. Same word in older builds meant the host — it collided with the counter.)
2. **Traffic** — `anthropic` vs `litellm` counts, plus `errors` and `blocked`. A `litellm`
   count of 0 after a session on a local model means routing is not actually happening
   (usually `ANTHROPIC_BASE_URL` is not set in `~/.claude/settings.json`).
3. **The claude door** — `plan_claude` counts requests that were local by name but went to
   Anthropic anyway, because the dashboard pinned that session's plan to `claude`. It is the
   **only** automatic-looking path to a paid model left, and it is deliberate: the operator
   set it in the panel. A non-zero `plan_claude` you did not authorise is the thing to chase;
   the router logs each one per request.
   - Older builds reported `fallback_*` / `cloud_breaker_*` counters for two *automatic*
     diversions (local-stalled→cloud, cloud-quota→local). Both were removed on 2026-09-17;
     if you see those keys, the deployed binary predates this repo's `main`.
4. **Hygiene** — `blocked` (requests refused outright), `errors` (upstream failures),
   `cleaned` (transcript keys stripped so the history stays replayable). `blocked` climbing
   with `errors` flat is the router rejecting input, not the backend being down.

If the request fails outright, the router is down or on another port — check
`pgrep -af claude-router.js` and say so plainly instead of reporting zeros.

$ARGUMENTS
