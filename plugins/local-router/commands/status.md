---
description: Show what the local router is doing right now — routing, counters, and whether fallbacks are armed
allowed-tools: Bash(curl:*), Bash(jq:*), Bash(pgrep:*)
---

# Router status

Read the live state of the local `claude-router` proxy and explain it.

Port: `${CLAUDE_ROUTER_PORT:-18791}`. Fetch:

```
curl -fsS -m 5 "http://127.0.0.1:${CLAUDE_ROUTER_PORT:-18791}/-/health"
```

Then report, in this order, **translating rather than dumping** the JSON:

1. **Routing** — `litellm` is the gateway local models go to; `local_re` is the regex a
   `model` must match to be sent there. Anything not matching goes to Anthropic untouched.
2. **Traffic** — `anthropic` vs `litellm` counts, plus `errors` and `blocked`. A `litellm`
   count of 0 after a session on a local model means routing is not actually happening
   (usually `ANTHROPIC_BASE_URL` is not set in `~/.claude/settings.json`).
3. **Fallbacks** — these are the two that cost money or hide problems, so be explicit:
   - `fallback_model` / `fallback_allowed` / `fallback_reason`: local→cloud when the local
     backend stalls. If `fallback_allowed` is `false`, say *why* from `fallback_reason`
     (no panel configured, quota nearly spent, or the reading is stale) — a disabled
     diversion is invisible unless you name the reason.
   - `cloud_fallback_model` / `cloud_breaker_until` / `cloud_breaker_reason`: cloud→local
     when Anthropic quota runs out. A non-null `cloud_breaker_until` means matching models
     are going local without paying for a failed request first.
4. **Pressure** — `local_inflight` and `local_stalled`. Several stalled local requests is
   the signature of too many concurrent sessions on one local model, which kills turns
   silently rather than loudly.

If the request fails outright, the router is down or on another port — check
`pgrep -af claude-router.js` and say so plainly instead of reporting zeros.

$ARGUMENTS
