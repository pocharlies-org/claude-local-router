# claude-local-router

Run **your own models inside Claude Code** — without giving up Anthropic's.

A ~470-line, zero-dependency Node proxy that sits on `127.0.0.1` and routes each request
**by model name**:

| request | goes to |
|---|---|
| `model` matches `CLAUDE_ROUTER_LOCAL_RE` (default `^(qwen\|tooling\|or-\|alibaba-\|q38-\|litellm/)`) | your OpenAI/Anthropic-compatible gateway (LiteLLM, vLLM, OpenRouter…) |
| everything else | `api.anthropic.com`, byte-for-byte passthrough |

So `opus`, `sonnet` and `fable` keep working exactly as before — same OAuth, same
subscription — while a model picker entry like `qwen38-flash-next` runs on hardware you own.

**Your Anthropic OAuth token is never forwarded to the local gateway.** The proxy strips
`authorization` / `x-api-key` and substitutes a dedicated gateway key before the request
leaves. That is the whole reason this exists as a proxy instead of an env var.

## Why not just set `ANTHROPIC_BASE_URL` to the gateway?

Because then *every* request goes local — you lose Opus/Sonnet in the same session, and the
CLI's model picker stops being a picker. Routing per-model is the point.

## What you get

- **Per-model routing**, one session, both worlds.
- **`GET /v1/models`** served locally. Without this the CLI validates `--model` against
  Anthropic's catalogue and fails intermittently with `unrecognized_model`, especially on
  cold start and when spawning subagents.
- **One deliberate door to Anthropic, and no automatic one.** A request whose model is
  local is checked against the dashboard's routing config
  (`CLAUDE_ROUTER_ROUTING_CONFIG_URL`); if the operator pinned that session's plan to
  `claude`, it goes to Anthropic as `CLAUDE_ROUTER_CLAUDE_PLAN_MODEL`. Unreachable config,
  stale config, or no `sticky`+`default_plan` → it stays local. Every diversion is logged
  per request.
  - The two automatic diversions this file used to document — *local saturated → cloud*
    and *cloud quota exhausted → local* — were **removed on 17-09-2026** with the code
    behind them. Local saturation is handled by admission control inside LiteLLM, not by a
    proxy guessing at latency, and a silent jump to a paid model is exactly what nobody
    wanted. `CLAUDE_ROUTER_PANEL_URL`, `CLAUDE_ROUTER_QUOTA_*`,
    `CLAUDE_ROUTER_FALLBACK_*` and `CLAUDE_ROUTER_CLOUD_FALLBACK_*` are no longer read.
- **A history guardrail.** Some gateways emit keys (`provider_specific_fields`) that
  Anthropic rejects once they're in the transcript, which poisons the *whole conversation*
  from that point on. `CLAUDE_ROUTER_MIXED=strip` (the default) removes them in flight.
- **`GET /-/health`** with live counters, the active config and *why* the claude door is
  currently open or shut — so a diversion nobody asked for is visible immediately instead of
  at the next outage.
- `SIGHUP` reloads the gateway URL/key without dropping the listener.

## The plugin owns the router; `proxy-claude` owns its source

Two copies of `claude-router.js` existed and drifted: this bundle froze at the commit that
introduced it, while the router kept being fixed in
[`pocharlies-org/proxy-claude`](https://github.com/pocharlies-org/proxy-claude). Because the
`SessionStart` hook below deploys the *bundled* bytes, every new Claude Code session quietly
reverted the router to the stale copy — on 2026-09-21 that took four chat profiles out of
`/v1/models` and re-enabled a paid-model diversion that had been retired four days earlier.

So the split is explicit now:

- **`proxy-claude/bin/claude-router.js` is the source of truth.** Router changes go there.
- **This repo is the distributor.** The bundle is a byte-for-byte copy of it, and
  `.github/workflows/bundle-drift.yml` fails any PR where the two differ.
- If you only have this repo, the bundle still installs and works — it is just a snapshot,
  and the CI gate is what keeps the snapshot honest.

The router and the Claude Code plugin are one deployable artifact. **The plugin is the only
thing that deploys the router** — there is no separate router install:

- The router binary ships **inside** the plugin (`plugins/local-router/bin/claude-router.js`).
- A **`SessionStart` hook** runs `scripts/deploy.sh` on every session. It is a fast no-op
  (silent, no work) unless the deployed router differs from the bundled one or the service
  is down.
- The deployed bytes change **only when you update the plugin** (updating rewrites the cache
  with the new bundled binary). So *to deploy a new router, you update the plugin* — that is
  the whole dependency, enforced by structure, not docs.
- `/local-router:install` runs the same deployer with `--force` for an immediate redeploy.

`deploy.sh` (bundled in the plugin) does the actual work: copies the router to
`~/.local/bin/claude-router.js`, creates `~/.config/claude-local/env` from `env.example` if
absent (never overwrites), installs a **launchd** agent (macOS) or **systemd --user** unit
(Linux) with the absolute `node` path, and patches `~/.claude/settings.json`
(`env.ANTHROPIC_BASE_URL` + missing `modelPicker` rows), backing it up and preserving every
existing key.

## Install

Fastest — the plugin deploys the router itself:

```
/plugin marketplace add pocharlies-org/claude-local-router
/plugin install local-router@claude-local-router
```

The next session's `SessionStart` hook deploys the router. For it now, without waiting,
`/local-router:install`.

Or bootstrap from a clone (installs the plugin, then deploys once so you don't wait):

```sh
git clone https://github.com/pocharlies-org/claude-local-router
cd claude-local-router && ./install.sh
```

Either way, fill in your gateway URL and key in `~/.config/claude-local/env` and:

```sh
# macOS
launchctl kickstart -k gui/$(id -u)/com.e-dani.claude-router
# Linux
systemctl --user restart claude-router

curl -s http://127.0.0.1:18791/-/health | python3 -m json.tool
```

Restart Claude Code and the new models appear in `/model`.

### Uninstall

`./install.sh --uninstall` removes the service and the router. It leaves your
`settings.json` and env file alone — revert those from the `.bak-*` the installer wrote.

## Configuration

Everything is environment-driven; there are no hardcoded hosts, models or credentials
anywhere in the source.

`~/.config/claude-local/env` supplies the gateway (read at start, reloaded on `SIGHUP`):

```sh
export ANTHROPIC_BASE_URL="https://your-gateway.example.com"   # where local models live
export ANTHROPIC_AUTH_TOKEN="sk-..."                           # a key scoped to that gateway
```

Service-level knobs go in the unit/plist — see the header of
[`plugins/local-router/bin/claude-router.js`](plugins/local-router/bin/claude-router.js),
which documents all 14 with their defaults. The ones you are most likely to touch:

| variable | default | meaning |
|---|---|---|
| `CLAUDE_ROUTER_PORT` | `18791` | listen port, `127.0.0.1` only |
| `CLAUDE_ROUTER_LOCAL_RE` | `^(qwen\|tooling\|or-\|alibaba-\|q38-\|litellm/)` | which models are "local" |
| `CLAUDE_ROUTER_MODELS` | the 9 aliases deployed on the x86 | what `/v1/models` advertises |
| `CLAUDE_ROUTER_ROUTING_CONFIG_URL` | `http://10.43.80.147:9002/api/model-routing/config` | dashboard routing config, read only on the `LOCAL_RE` branch |
| `CLAUDE_ROUTER_CLAUDE_PLAN_MODEL` | `claude-opus-5` | where a session the dashboard marked `plan=claude` goes |
| `CLAUDE_ROUTER_FORCE_LOCAL_MODEL` | *(empty = off)* | rewrite the requested model to this one **before** routing, so a session born anywhere (phone via RC, Claude Desktop, VS Code) lands on the same local resident even when it asks for `claude-opus-5`. Turn it on in a systemd **drop-in**, not in the unit — the SessionStart hook regenerates the unit |

> **There is no automatic diversion to Anthropic.** The `CLAUDE_ROUTER_FALLBACK_MODEL`
> (local-saturated) and `CLAUDE_ROUTER_CLOUD_FALLBACK_MODEL` (quota) knobs were removed
> on 17-09-2026 along with the code behind them: saturation is handled by admission
> control inside LiteLLM, and a session reaches Opus only when the operator says so in
> the dashboard. Setting those variables now does nothing.
>
> `CLAUDE_ROUTER_FORCE_LOCAL_MODEL` is the **opposite** direction (Anthropic → local) and is
> not automatic either: it only does what the operator put in the drop-in.

## Commands

Namespaced by plugin. From a shell: `claude -p "/local-router:status"`.

- **`/local-router:install`** — deploy/redeploy the router from the plugin's bundled binary
  (`deploy.sh --force`). The only way the router gets placed.
- **`/local-router:status`** — explain `/-/health`: routing, traffic, and the state of the claude door
  (including *why* one is blocked), and stall pressure.
- **`/local-router:reload`** — re-read the gateway URL/key on `SIGHUP` without dropping
  in-flight streams.

`claude plugin details local-router` shows the inventory (3 commands + the SessionStart hook)
and token cost.

## Requirements

Node ≥ 18 (no dependencies), Claude Code, and a gateway that speaks the Anthropic
`/v1/messages` API — LiteLLM does this natively.

## Troubleshooting

**`curl` reaches the gateway but the router gets `EHOSTUNREACH` to the same host.**
Almost always interface selection on a multi-homed machine. If two interfaces sit on the
same subnet (e.g. Wi-Fi `en0` and a Thunderbolt/USB dock `en8`, both `192.168.50.0/24`),
`curl` picks the working one and Node picks the other — and the connect fails even though
`nc -z -s <bad-ip> <gateway> 443` says "succeeded", because the failure is at connect/ARP
time, not at the port check.

- Confirm it: the router's log line names the source IP it used — `… Local
  (192.168.50.59:56610)`. If that IP isn't the interface you expect, that's the cause.
- Fix without touching Node: point `ANTHROPIC_BASE_URL` at a host that resolves to a
  **public** IP (routed via the default gateway, so interface choice stops mattering).
  The LAN hostname resolving to a LAN IP is the trigger.
- A reload applies it live: `kill -HUP $(pgrep -f claude-router.js)`.

**`/-/health` shows a model routed local returning Anthropic errors.** The model name
didn't match `local_re`. Add its prefix to `CLAUDE_ROUTER_LOCAL_RE` and reload.

**The CLI rejects `--model <local-model>` with `unrecognized_model`,** even with a
`modelPicker` row that has `behavesAs`: the `--model` flag validates against the CLI's
built-in catalog on some versions, a different path than the interactive picker. Use the
picker (`/model`) for local models, and set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the model's
real window so auto-compact doesn't assume 200k.

## Security

- Binds `127.0.0.1` exclusively; it is not reachable off-box.
- Anthropic credentials are never sent to the gateway, and the gateway key is never sent to
  Anthropic.
- `~/.config/claude-local/env` holds the only secret and is **not** in this repo;
  `.gitignore` covers `env` and `*.local`.

## License

MIT
