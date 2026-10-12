#!/usr/bin/env bash
# SC-2349: deploy.sh no sustituye el router desplegado por el de un plugin MENOR (una sesión
# arrancada con el plugin viejo lo bajó el 12-10-2026). Corre el deploy.sh real en un HOME
# temporal; systemctl, launchctl y curl son de mentira, así que no toca el servicio del host.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
src=$here/../plugins/local-router
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/stub"
for c in systemctl launchctl; do printf '#!/bin/sh\necho "%s $*" >> "$STUB_LOG"\n' "$c" > "$tmp/stub/$c"; done
printf '#!/bin/sh\nexit 22\n' > "$tmp/stub/curl"
chmod +x "$tmp/stub"/*

# plugin <versión>: un plugin instalado (su caché) con su router, que lleva su versión dentro.
plugin() {
  local d="$tmp/plugin-$1"
  [ -d "$d" ] && return
  mkdir -p "$d/.claude-plugin" "$d/bin"
  printf '{"name":"local-router","version":"%s"}\n' "$1" > "$d/.claude-plugin/plugin.json"
  echo "// router $1" > "$d/bin/claude-router.js"
  cp -r "$src/scripts" "$src/env.example" "$d/"
}

reset() { rm -rf "$tmp/home"; mkdir -p "$tmp/home/.local/bin" "$tmp/home/.claude"; : > "$tmp/calls"; }

# hook <versión> [args]: lo que lanza el SessionStart de una sesión cuyo CLAUDE_PLUGIN_ROOT es esa versión.
hook() {
  local v=$1; shift
  plugin "$v"
  HOME="$tmp/home" PATH="$tmp/stub:$PATH" STUB_LOG="$tmp/calls" CLAUDE_PLUGIN_ROOT="$tmp/plugin-$v" \
    bash "$tmp/plugin-$v/scripts/deploy.sh" "$@" >/dev/null 2>"$tmp/stderr"
  rc=$?
}

deployed() { head -1 "$tmp/home/.local/bin/claude-router.js"; }
expect() { # <nombre> <esperado> <obtenido>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: esperaba '$2', obtuve '$3'"; fail=1; fi
}

reset; hook 2.9.0; : > "$tmp/calls"; hook 2.8.0
expect "2.9.0 desplegada, hook 2.8.0: no toca el router" "// router 2.9.0" "$(deployed)"
expect "  el hook no falla" 0 "$rc"
expect "  lo dice una vez en stderr" 1 "$(wc -l < "$tmp/stderr")"
expect "  no reinicia ni recarga nada" 0 "$(wc -l < "$tmp/calls")"

reset; hook 2.8.0; hook 2.9.0
expect "2.8.0 desplegada, hook 2.9.0: lo sustituye" "// router 2.9.0" "$(deployed)"
expect "  y el despliegue llega al final" 0 "$rc"

reset; hook 2.9.0; hook 2.10.0
expect "2.9.0 desplegada, hook 2.10.0: lo sustituye (semver, no texto)" "// router 2.10.0" "$(deployed)"

reset; hook 2.10.0; hook 2.9.0
expect "2.10.0 desplegada, hook 2.9.0: no toca el router (semver, no texto)" "// router 2.10.0" "$(deployed)"

reset; echo "// router 2.8.0" > "$tmp/home/.local/bin/claude-router.js"; hook 2.9.0
expect "sin versión desplegada (instalación de hoy): despliega" "// router 2.9.0" "$(deployed)"
expect "  y sin decir nada en stderr" 0 "$(wc -c < "$tmp/stderr")"

reset; hook 2.10.0; echo "// router 2.8.0" > "$tmp/home/.local/bin/claude-router.js"; hook 2.9.0
expect "versión anotada de otros bytes (un hook viejo lo reescribió): despliega" "// router 2.9.0" "$(deployed)"

reset; hook 2.9.0; hook 2.8.0 --force
expect "--force (explícito) sí baja" "// router 2.8.0" "$(deployed)"

reset; hook 2.9.0; hook 2.9.0 --uninstall
expect "--uninstall borra también la versión anotada" "" "$(ls "$tmp/home/.local/bin")"

exit $fail
