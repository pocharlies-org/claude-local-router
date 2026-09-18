#!/usr/bin/env bash
# Deploys the router that SHIPS INSIDE THIS PLUGIN. This is the only thing that puts
# ~/.local/bin/claude-router.js — the plugin owns the router.
#
# Invoked by:
#   - the SessionStart hook (every session; a fast no-op unless the plugin changed)
#   - /local-router:install (explicit, --force)
#
# "To deploy the router you update the plugin": the deployed binary is refreshed only
# when the bundled bytes differ from the deployed ones, and those change only when the
# plugin is updated (the cache is rewritten). So a plugin update => next session
# redeploys the router; an unchanged plugin => the hook does nothing and says nothing.
#
#   deploy.sh            idempotent deploy (no-op if current + healthy)
#   deploy.sh --force    redeploy the bundled router even if it matches
#   deploy.sh --uninstall
set -euo pipefail

# ${CLAUDE_PLUGIN_ROOT} is set when run as a hook; fall back to this script's dir so the
# same file works from a plain shell / the bootstrap installer.
ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ROUTER_SRC="$ROOT/bin/claude-router.js"
ENV_EXAMPLE="$ROOT/env.example"

BIN="$HOME/.local/bin/claude-router.js"
ENV_DIR="$HOME/.config/claude-local"
ENV_FILE="$ENV_DIR/env"
SETTINGS="$HOME/.claude/settings.json"
LABEL="com.e-dani.claude-router"
UNIT="$HOME/.config/systemd/user/claude-router.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CLAUDE_ROUTER_PORT:-18791}"
ROUTER_MODELS="${ROUTER_MODELS:-qwen38-flash-next,qwen38-flash-next-uncensored}"

log() { printf '%s\n' "$*"; }
die() { printf '! %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in Darwin) SVC=launchd ;; Linux) SVC=systemd ;; *) die "SO no soportado: $OS" ;; esac

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }
healthy() { curl -fsS -m 3 "http://127.0.0.1:$PORT/-/health" >/dev/null 2>&1; }

# ------------------------------------------------------------------ uninstall
if [ "${1:-}" = "--uninstall" ]; then
  if [ "$SVC" = launchd ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"
  else
    systemctl --user disable --now claude-router.service 2>/dev/null || true
    rm -f "$UNIT"; systemctl --user daemon-reload 2>/dev/null || true
  fi
  rm -f "$BIN"
  log "claude-router service and $BIN removed."
  log "Left in place on purpose: $ENV_FILE (your key) and $SETTINGS."
  exit 0
fi

[ -f "$ROUTER_SRC" ] || die "no falta el router empaquetado ($ROUTER_SRC)"

# ------------------------------------------------------- fast no-op (the hook path)
# Runs on EVERY SessionStart. When the deployed router already matches the bundled one
# and the service is healthy, do nothing and print nothing — a hook that talks every
# session pollutes every session.
if [ "${1:-}" != "--force" ] && [ -f "$BIN" ] \
   && [ "$(sha "$BIN")" = "$(sha "$ROUTER_SRC")" ] && healthy; then
  exit 0
fi

# ------------------------------------------------------------------ preflight
NODE=""
for c in "${NODE_OVERRIDE:-}" "$(command -v node 2>/dev/null || true)" \
         /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
         $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1) \
         $(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1); do
  [ -n "$c" ] && [ -x "$c" ] && NODE="$c" && break
done
[ -n "$NODE" ] || die "no encuentro node. brew install node, o NODE_OVERRIDE=/ruta/node"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "requiere node >= 18, hay $("$NODE" -v)"
REAL="$("$NODE" -p 'process.execPath' 2>/dev/null || true)"
[ -n "$REAL" ] && [ -x "$REAL" ] && NODE="$REAL"
"$NODE" --check "$ROUTER_SRC" || die "el router empaquetado no parsea"

# ------------------------------------------------------------------ deploy
mkdir -p "$HOME/.local/bin" "$ENV_DIR"; chmod 700 "$ENV_DIR"
cp "$ROUTER_SRC" "$BIN"; chmod 755 "$BIN"

if [ -f "$ENV_FILE" ]; then :; else
  cp "$ENV_EXAMPLE" "$ENV_FILE"; chmod 600 "$ENV_FILE"
fi

if [ "$SVC" = launchd ]; then
  LOG_DIR="$HOME/Library/Logs"; mkdir -p "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$BIN</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CLAUDE_ROUTER_PORT</key><string>$PORT</string>
    <key>CLAUDE_ROUTER_MODELS</key><string>$ROUTER_MODELS</string>
    <key>CLAUDE_ROUTER_FALLBACK_MODEL</key><string>off</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_DIR/claude-router.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/claude-router.err</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNIT
[Unit]
Description=claude-router: proxy local por-modelo para Claude Code
After=network-online.target

[Service]
ExecStart=$NODE $BIN
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=2
Environment=CLAUDE_ROUTER_PORT=$PORT
Environment=CLAUDE_ROUTER_MODELS=$ROUTER_MODELS
Environment=CLAUDE_ROUTER_FALLBACK_MODEL=off

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now claude-router.service
fi

# ---- settings.json: point Claude Code at the router + register the picker models ----
if [ -f "$SETTINGS" ]; then cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"; fi
SETTINGS="$SETTINGS" ROUTER_MODELS="$ROUTER_MODELS" PORT="$PORT" python3 - <<'PY'
import json, os, sys
path=os.environ["SETTINGS"]; port=os.environ["PORT"]
models=[m.strip() for m in os.environ["ROUTER_MODELS"].split(",") if m.strip()]
try:
    cfg=json.load(open(path))
    if not isinstance(cfg,dict): raise ValueError("raiz no es objeto JSON")
except FileNotFoundError: cfg={}
except Exception as e:
    print(f"! {path}: {e} — edítalo a mano: env.ANTHROPIC_BASE_URL=http://127.0.0.1:{port}")
    sys.exit(0)
changed=[];added=[]
env=cfg.setdefault("env",{}); want=f"http://127.0.0.1:{port}"
if env.get("ANTHROPIC_BASE_URL")!=want: env["ANTHROPIC_BASE_URL"]=want; changed.append("env.ANTHROPIC_BASE_URL")
picker=cfg.setdefault("modelPicker",{}); opts=picker.setdefault("options",[])
have={o.get("model") for o in opts if isinstance(o,dict)}
for m in models:
    if m in have: continue
    opts.append({"model":m,"label":f"{m} (local)","description":"via claude-local-router","behavesAs":"sonnet"}); added.append(m)
if changed or added:
    json.dump(cfg,open(path,"w"),indent=2,ensure_ascii=False); open(path,"a").write("\n")
    if changed: print("  "+", ".join(changed))
    if added: print("  picker: "+", ".join(added))
PY

# ------------------------------------------------------------------ verify
if grep -q CHANGEME "$ENV_FILE" 2>/dev/null; then
  log "claude-router desplegado. FALTA 1 PASO: rellena $ENV_FILE (gateway URL + key) y arranca:"
  [ "$SVC" = launchd ] && log "  launchctl kickstart -k gui/$(id -u)/$LABEL" \
                       || log "  systemctl --user restart claude-router"
  exit 0
fi
sleep 1
if healthy; then
  log "claude-router desplegado y sano en :$PORT (gateway $(curl -fsS -m3 http://127.0.0.1:$PORT/-/health | python3 -c 'import json,sys;print(json.load(sys.stdin).get("gateway"))' 2>/dev/null || echo '?'))"
else
  log "desplegado pero NO contesta en :$PORT — mira el log:"
  [ "$SVC" = launchd ] && log "  tail -20 ~/Library/Logs/claude-router.err" \
                       || log "  journalctl --user -u claude-router -n 20"
fi
