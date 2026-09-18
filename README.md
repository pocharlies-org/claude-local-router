# claude-local-router

Run **your own models inside Claude Code** — without giving up Anthropic's.

A ~470-line, zero-dependency Node proxy that sits on `127.0.0.1` and routes each request
**by model name**:

| request | goes to |
|---|---|
| `model` matches `CLAUDE_ROUTER_LOCAL_RE` (default `^(qwen\|tooling\|or-\|litellm/)`) | your OpenAI/Anthropic-compatible gateway (LiteLLM, vLLM, OpenRouter…) |
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
- **Two independent, optional fallbacks** (both off unless configured):
  - *local saturated → cloud*: if N local requests stall past a threshold, divert to an
    Anthropic model. Gated on real remaining quota, read from a status endpoint you supply
    (`CLAUDE_ROUTER_PANEL_URL`). **No endpoint, no diversion** — it fails closed, so it
    can never quietly burn quota you don't have.
  - *cloud quota exhausted → local*: when Anthropic answers "out of quota" for a matching
    model, retry locally and open a short breaker. Driven by the actual API response, not a
    clock.
- **A history guardrail.** Some gateways emit keys (`provider_specific_fields`) that
  Anthropic rejects once they're in the transcript, which poisons the *whole conversation*
  from that point on. `CLAUDE_ROUTER_MIXED=strip` (the default) removes them in flight.
- **`GET /-/health`** with live counters, the active config and *why* a fallback is
  currently allowed or blocked — so a disabled diversion is visible immediately instead of
  at the next outage.
- `SIGHUP` reloads the gateway URL/key without dropping the listener.

## The plugin owns the router

The router and the Claude Code plugin are one artifact. **The plugin is the only thing that
deploys the router** — there is no separate router install:

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
[`bin/claude-router.js`](bin/claude-router.js), which documents all 16 with their defaults.
The ones you are most likely to touch:

| variable | default | meaning |
|---|---|---|
| `CLAUDE_ROUTER_PORT` | `18791` | listen port, `127.0.0.1` only |
| `CLAUDE_ROUTER_LOCAL_RE` | `^(qwen\|tooling\|or-\|litellm/)` | which models are "local" |
| `CLAUDE_ROUTER_MODELS` | `qwen38-flash-next,qwen38-flash-next-uncensored` | what `/v1/models` advertises |
| `CLAUDE_ROUTER_FALLBACK_MODEL` | `claude-opus-5` | local-saturated diversion; `off` to disable |
| `CLAUDE_ROUTER_CLOUD_FALLBACK_MODEL` | *(empty = off)* | local model to use when cloud quota runs out |

> **Set `CLAUDE_ROUTER_FALLBACK_MODEL=off` unless you actually run a quota endpoint.**
> Without one the gate fails closed anyway, but `off` states the intent and keeps
> `/-/health` honest.

## Commands

Namespaced by plugin. From a shell: `claude -p "/local-router:status"`.

- **`/local-router:install`** — deploy/redeploy the router from the plugin's bundled binary
  (`deploy.sh --force`). The only way the router gets placed.
- **`/local-router:status`** — explain `/-/health`: routing, traffic, both fallbacks
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
