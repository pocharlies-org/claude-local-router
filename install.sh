#!/usr/bin/env bash
# claude-local-router installer. Idempotent. Safe to re-run.
#
#   ./install.sh              install / update
#   ./install.sh --uninstall  remove the service and the binary
#
# What it touches, and nothing else:
#   ~/.local/bin/claude-router.js
#   ~/.config/claude-local/env            (created from env.example ONLY if absent)
#   ~/Library/LaunchAgents/com.e-dani.claude-router.plist   (macOS)
#   ~/.config/systemd/user/claude-router.service            (Linux)
#   ~/.claude/settings.json               (backed up to .bak-<ts> first)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin/claude-router.js"
ENV_DIR="$HOME/.config/claude-local"
ENV_FILE="$ENV_DIR/env"
SETTINGS="$HOME/.claude/settings.json"
LABEL="com.e-dani.claude-router"
UNIT="$HOME/.config/systemd/user/claude-router.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CLAUDE_ROUTER_PORT:-18791}"
# Models advertised by /v1/models and added to the picker. Override at install time:
#   ROUTER_MODELS="my-model,other-model" ./install.sh
ROUTER_MODELS="${ROUTER_MODELS:-qwen38-flash-next,qwen38-flash-next-uncensored}"

log() { printf '  %s\n' "$*"; }
die() { printf '  ! %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in Darwin) SVC=launchd ;; Linux) SVC=systemd ;; *) die "SO no soportado: $OS" ;; esac

TMP_H="$(mktemp)"
trap 'rm -f "$TMP_H"' EXIT

# ---------------------------------------------------------------- uninstall
if [ "${1:-}" = "--uninstall" ]; then
  printf 'Uninstalling claude-local-router (%s)\n' "$SVC"
  if [ "$SVC" = launchd ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
  else
    systemctl --user disable --now claude-router.service 2>/dev/null || true
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  rm -f "$BIN"
  log "removed the service and $BIN"
  log "LEFT IN PLACE on purpose: $ENV_FILE (holds your key) and $SETTINGS."
  log "to stop Claude Code routing locally, restore a settings.json.bak-* or drop"
  log "env.ANTHROPIC_BASE_URL from it."
  exit 0
fi

# ---------------------------------------------------------------- preflight
# Neither launchd nor a non-interactive ssh shell loads your shell rc, so on macOS
# /opt/homebrew/bin is frequently missing from PATH even when node is installed. Search
# the usual places before giving up — the service needs an absolute path regardless.
NODE=""
for c in "${NODE_OVERRIDE:-}" \
         "$(command -v node 2>/dev/null || true)" \
         /opt/homebrew/bin/node /usr/local/bin/node \
         "$HOME/.volta/bin/node" \
         $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1) \
         $(ls -d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -V | tail -1) \
         $(brew --prefix 2>/dev/null | sed 's|$|/bin/node|'); do
  [ -n "$c" ] && [ -x "$c" ] && NODE="$c" && break
done
[ -n "$NODE" ] || die "no encuentro node. Instálalo (brew install node) o indica la ruta:
    NODE_OVERRIDE=/ruta/al/node ./install.sh"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "requiere node >= 18, hay $("$NODE" -v) en $NODE"

# launchd/systemd do not inherit your shell PATH, so a shim or version-manager stub is
# not enough. process.execPath is the real binary, and portable across BSD/GNU readlink.
REAL="$("$NODE" -p 'process.execPath' 2>/dev/null || true)"
[ -n "$REAL" ] && [ -x "$REAL" ] && NODE="$REAL"
log "node $NODE"

[ -f "$HERE/bin/claude-router.js" ] || die "falta bin/claude-router.js"
node --check "$HERE/bin/claude-router.js" || die "bin/claude-router.js no parsea"

# ---------------------------------------------------------------- 1. binary
mkdir -p "$HOME/.local/bin" "$ENV_DIR"
chmod 700 "$ENV_DIR"
cp "$HERE/bin/claude-router.js" "$BIN"
chmod 755 "$BIN"
log "instalado $BIN"

# ---------------------------------------------------------------- 2. env file
if [ -f "$ENV_FILE" ]; then
  log "$ENV_FILE ya existe — NO lo toco"
else
  cp "$HERE/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "creado $ENV_FILE (600) — EDITA ANTHROPIC_BASE_URL y ANTHROPIC_AUTH_TOKEN"
fi

# ---------------------------------------------------------------- 3. service
if [ "$SVC" = launchd ]; then
  LOG_DIR="$HOME/Library/Logs"
  mkdir -p "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$BIN</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CLAUDE_ROUTER_PORT</key><string>$PORT</string>
    <key>CLAUDE_ROUTER_MODELS</key><string>$ROUTER_MODELS</string>
    <!-- No hay reloj de cuota aqui: sin PANEL_URL el desvio a la nube falla cerrado.
         Si montas uno, descomenta y el gate se abre solo. -->
    <!--
    <key>CLAUDE_ROUTER_PANEL_URL</key><string>http://127.0.0.1:8799/v1/accounts</string>
    -->
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
  log "servicio launchd $LABEL cargado"
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
# Sin reloj de cuota el desvio a la nube falla cerrado. Si montas un PANEL_URL,
# cambia 'off' por el modelo al que quieras desviar.
Environment=CLAUDE_ROUTER_FALLBACK_MODEL=off

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now claude-router.service
  log "unidad systemd claude-router.service activada"
fi

# ---------------------------------------------------------------- 4. settings.json
if [ -f "$SETTINGS" ]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$SETTINGS.bak-$TS"
  log "copia de seguridad $SETTINGS.bak-$TS"
fi

SETTINGS="$SETTINGS" ROUTER_MODELS="$ROUTER_MODELS" PORT="$PORT" python3 - <<'PY'
import json, os, re, sys

path = os.environ["SETTINGS"]
port = os.environ["PORT"]
models = [m.strip() for m in os.environ["ROUTER_MODELS"].split(",") if m.strip()]

try:
    with open(path) as fh:
        cfg = json.load(fh)
    if not isinstance(cfg, dict):
        raise ValueError("la raiz no es un objeto JSON")
except FileNotFoundError:
    cfg = {}
except Exception as exc:
    print(f"  ! {path}: {exc} — NO lo toco, edita a mano:")
    print(f"    env.ANTHROPIC_BASE_URL = http://127.0.0.1:{port}")
    print(f"    modelPicker.options += {models}")
    sys.exit(0)

added, changed = [], []

env = cfg.setdefault("env", {})
if not isinstance(env, dict):
    env = {}
    cfg["env"] = env
want = f"http://127.0.0.1:{port}"
if env.get("ANTHROPIC_BASE_URL") != want:
    env["ANTHROPIC_BASE_URL"] = want
    changed.append("env.ANTHROPIC_BASE_URL")

picker = cfg.setdefault("modelPicker", {})
if not isinstance(picker, dict):
    picker = {}
    cfg["modelPicker"] = picker
opts = picker.setdefault("options", [])
if not isinstance(opts, list):
    opts = []
    picker["options"] = []
have = {o.get("model") for o in opts if isinstance(o, dict)}
for m in models:
    if m in have:
        continue
    opts.append({
        "model": m,
        "label": f"{m} (local)",
        "description": "via claude-local-router",
        "behavesAs": "sonnet",
    })
    added.append(m)

if not added and not changed:
    print("  settings.json ya estaba bien — 0 cambios")
else:
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)
    if changed:
        print("  actualizado: " + ", ".join(changed))
    if added:
        print("  alto en el picker: " + ", ".join(added))
PY

# ---------------------------------------------------------------- 5. verify
# A freshly-copied env.example still says CHANGEME. Starting the router then would only
# crash-loop (loadLiteLLM throws on a missing/placeholder token), so stop here and make
# the user fill it in first.
if grep -q 'CHANGEME' "$ENV_FILE" 2>/dev/null; then
  printf '\n  FALTA 1 PASO — %s tiene los marcadores sin rellenar.\n' "$ENV_FILE"
  printf '  Edítalo y arranca:\n'
  case "$SVC" in
    launchd) printf '    $EDITOR %s && launchctl kickstart -k gui/$(id -u)/%s\n' "$ENV_FILE" "$LABEL" ;;
    systemd) printf '    $EDITOR %s && systemctl --user restart claude-router\n' "$ENV_FILE" ;;
  esac
  printf '\n  El binario, el servicio y settings.json YA están instalados.\n'
  exit 0
fi

sleep 1
HEALTH_URL="http://127.0.0.1:$PORT/-/health"
if ! curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
  printf '\n  ! el router no contesta en %s\n' "$HEALTH_URL"
  case "$SVC" in
    launchd) printf '    tail -20 ~/Library/Logs/claude-router.err\n' ;;
    systemd) printf '    journalctl --user -u claude-router -n 20 --no-pager\n' ;;
  esac
  exit 1
fi

printf '\n  OK — router arriba en el puerto %s\n' "$PORT"
curl -fsS -m 5 "$HEALTH_URL" >"$TMP_H"
python3 - "$TMP_H" <<'PY'
import json, sys
h = json.load(open(sys.argv[1]))
print("    gateway   %s" % h.get("litellm"))
print("    locales   %s" % h.get("local_re"))
print("    fallback  %s (permitido: %s)" % (h.get("fallback_model"), h.get("fallback_allowed")))
PY
rm -f "$TMP_H"
printf '\n  Reinicia Claude Code y verás los modelos en /model.\n'
printf '  Prueba:  claude -p "hola" --model %s\n' "${ROUTER_MODELS%%,*}"
