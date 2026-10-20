#!/usr/bin/env bash
# Self-check de cambios.sh con un gh y un repo falsos (sin tocar GitHub).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# gh falso: un PR con 13 checks en verde y 1 en marcha.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/bin/sh
case "$PWD" in *wt-sin-pr*) exit 1;; esac
case "${GH_FAKE:-pr}" in
  pr) echo '{"number":207,"title":"stt-turbo vuelve a g","statusCheckRollup":[' \
      "$(for i in $(seq 13); do printf '{"status":"COMPLETED","conclusion":"SUCCESS"},'; done)" \
      '{"status":"IN_PROGRESS","conclusion":null}]}' ;;
  fail) echo '{"number":208,"title":"rojo","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"COMPLETED","conclusion":"FAILURE"}]}' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"

# Un clone con dos worktrees por convención de la casa: uno con PR, otro sin PR.
mkdir -p "$tmp/repoA/.claude/worktrees"
for name in wt-pr wt-sin-pr; do
  d="$tmp/repoA/.claude/worktrees/$name"
  git init -q -b feat "$d" 2>/dev/null || git init -q "$d"
  git -C "$d" config remote.origin.url git@github.com:acme/repoA.git
  git -C "$d" commit -q --allow-empty -m x 2>/dev/null
done

out=$(PATH="$tmp/bin:$PATH" bash "$HERE/cambios.sh" "$tmp")
echo "$out"

fail=0
check() { grep -q "$1" <<<"$out" || { echo "FALTA: $1"; fail=1; }; }
check 'repoA #207 · stt-turbo vuelve a g · 13/14 · EN MARCHA'
check 'repoA · feat · sin PR'

out=$(GH_FAKE=fail PATH="$tmp/bin:$PATH" bash "$HERE/cambios.sh" "$tmp")
grep -q '1/2 · ROJA (1)' <<<"$out" || { echo "FALTA: ROJA"; fail=1; }

[ "$fail" -eq 0 ] && echo "OK" || { echo "TEST FALLA"; exit 1; }
