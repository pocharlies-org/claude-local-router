#!/usr/bin/env bash
# Prueba tests/check-plugin-version.sh en repos temporales: cada caso es un base y un head.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
check="$here/check-plugin-version.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

# caso <nombre> <versión en head> <fichero que cambia en head> <esperado: 0|1>
caso() {
  local name=$1 head_version=$2 changed=$3 want=$4 dir="$tmp/$1"
  mkdir -p "$dir/plugins/local-router/.claude-plugin" "$dir/plugins/local-router/bin" \
           "$dir/plugins/local-router/scripts" "$dir/plugins/local-router/hooks" "$dir/plugins/local-router/commands"
  (
    cd "$dir" && git init -q && git config user.email t@t && git config user.name t
    printf '{"name":"local-router","version":"2.7.0"}\n' > plugins/local-router/.claude-plugin/plugin.json
    echo 'router v1' > plugins/local-router/bin/claude-router.js
    echo 'deploy v1' > plugins/local-router/scripts/deploy.sh
    echo 'readme v1' > README.md
    git add -A && git commit -qm base
    local base; base=$(git rev-parse HEAD)
    printf '{"name":"local-router","version":"%s"}\n' "$head_version" > plugins/local-router/.claude-plugin/plugin.json
    echo "$changed" | grep -q 'bin' && echo 'router v2' > plugins/local-router/bin/claude-router.js
    echo "$changed" | grep -q 'scripts' && echo 'deploy v2' > plugins/local-router/scripts/deploy.sh
    echo "$changed" | grep -q 'readme' && echo 'readme v2' > README.md
    git add -A && git commit -qm head
    "$check" "$base" HEAD >/dev/null 2>&1
  )
  local got=$?
  if [ "$got" = "$want" ]; then
    echo "ok   $name (exit $got)"
  else
    echo "FAIL $name: esperaba exit $want, salió $got"
    fail=1
  fi
}

caso bin-sin-subir-version  2.7.0 bin     1
caso bin-con-version-nueva  2.8.0 bin     0
caso scripts-sin-version    2.7.0 scripts 1
caso scripts-version-menor  2.6.0 scripts 1
caso solo-readme            2.7.0 readme  0

exit $fail
