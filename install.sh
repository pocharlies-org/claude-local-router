#!/usr/bin/env bash
# Bootstrap: installs the local-router PLUGIN, which is what actually deploys the router.
# There is no separate router install — the plugin owns it (see
# plugins/local-router/scripts/deploy.sh). The plugin's SessionStart hook deploys the
# router on the next session; we also run it once now so you don't have to wait.
#
#   ./install.sh              install the plugin + deploy the router now
#   ./install.sh --uninstall  remove the router service (leaves the plugin + your key)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$HERE/plugins/local-router"

if [ "${1:-}" = "--uninstall" ]; then
  exec bash "$PLUGIN/scripts/deploy.sh" --uninstall
fi

command -v claude >/dev/null 2>&1 || { echo "! falta el CLI de Claude Code" >&2; exit 1; }

# 1. make the plugin available and install it (this is the router's only source).
claude plugin marketplace add pocharlies-org/claude-local-router 2>/dev/null \
  || echo "  (marketplace ya dado de alta)"
claude plugin install local-router@claude-local-router

# 2. deploy the router from the plugin we just installed (or, if claude put it in the
#    cache, from there). Prefer the cache so the deployed bytes match what the hook uses.
DEPLOY="$(ls -d "$HOME"/.claude/plugins/cache/claude-local-router/local-router/*/scripts/deploy.sh 2>/dev/null | sort -V | tail -1)"
[ -n "$DEPLOY" ] || DEPLOY="$PLUGIN/scripts/deploy.sh"
echo "--- despliegando el router desde el plugin ---"
bash "$DEPLOY" --force

echo
echo "Reinicia Claude Code: el hook SessionStart mantendrá el router al día con el plugin."
echo "Comandos: /local-router:status · /local-router:reload · /local-router:install"
