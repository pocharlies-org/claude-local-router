#!/usr/bin/env bash
# Falla si el diff toca el router o sus scripts sin subir la versión de plugin.json:
# la caché del plugin solo se renueva con una versión nueva, y el SessionStart
# vuelve a escribir los bytes viejos de esa caché en ~/.local/bin/claude-router.js.
# Uso: check-plugin-version.sh <sha-base> [<head>]   (desde la raíz del repo, con historial completo)
set -euo pipefail

base=$1
head=${2:-HEAD}
plugin=plugins/local-router
manifest=$plugin/.claude-plugin/plugin.json

changed=$(git diff --name-only "$base" "$head" -- "$plugin/bin" "$plugin/scripts" "$plugin/hooks" "$plugin/commands")
[ -n "$changed" ] || exit 0

version_of() { git show "$1:$manifest" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])' || true; }
base_v=$(version_of "$base")
[ -n "$base_v" ] || exit 0   # el plugin no existía en la base: nada que comparar
head_v=$(version_of "$head")

newest=$(printf '%s\n%s\n' "$base_v" "$head_v" | sort -V | tail -1)
if [ "$head_v" = "$base_v" ] || [ "$newest" != "$head_v" ]; then
  echo "::error::la PR cambia $plugin sin subir la versión de $manifest (sigue en $head_v; la base tiene $base_v)." >&2
  echo "::error::Sube la versión (p. ej. a una mayor que $base_v). Sin versión nueva la caché del plugin no se renueva y el SessionStart revierte el router a los bytes viejos." >&2
  echo "$changed" | sed 's/^/  cambiado: /' >&2
  exit 1
fi
