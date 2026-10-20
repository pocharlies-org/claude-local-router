#!/usr/bin/env bash
# Cambios: los PRs, los checks de GitHub Actions y los worktrees de esta sesión,
# como el panel «Cambios» de Claude Desktop (que resuelve el PR por la rama del
# worktree y lee el check rollup del commit head — aquí, gh pr view).
#
#   cambios.sh [root]   (default: $PWD)
#
# Una línea por PR abierto:  repo #num · título · ok/total · ESTADO
#   ESTADO: VERDE | ROJA (n) | EN MARCHA | SIN CHECKS
# Un worktree sin PR abierto: repo · rama · sin PR
set -uo pipefail

ROOT="${1:-$PWD}"
command -v gh >/dev/null 2>&1 || { echo "gh no instalado: no puedo consultar los PRs"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "jq no instalado"; exit 0; }

# Worktrees por convención de la casa: <clone>/.claude/worktrees/<KEY>-<topic> y <clone>/.wt-<KEY>.
# shortcut: el root debe estar a un nivel de los clones (~/k8s); con productos anidados
# (~/proyectos/<producto>/<repo>) pasa el root del producto.
mapfile -t wts < <(
  find "$ROOT" -maxdepth 5 \( -path '*/.claude/worktrees/*' -o -name '.wt-*' \) \
       -name .git -printf '%h\n' 2>/dev/null
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 && echo "$ROOT"
)

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for wt in "${wts[@]}"; do
  (
    branch=$(git -C "$wt" branch --show-current 2>/dev/null) || exit
    [ -n "$branch" ] || exit
    repo=$(git -C "$wt" config --get remote.origin.url 2>/dev/null | sed -E 's#.*[/:]##; s#\.git$##')
    [ -n "$repo" ] || exit
    json=$(cd "$wt" && GH_PAGER=cat gh pr view --json number,title,statusCheckRollup 2>/dev/null) || exit
    [ -n "$json" ] || exit
    echo "$json" | jq -r --arg repo "$repo" --arg branch "$branch" '
      (.statusCheckRollup // []) as $c
      | ([$c[] | (.conclusion // .state // "PENDING") | ascii_upcase] ) as $x
      | ([$x[] | select(. == "SUCCESS" or . == "SKIPPED" or . == "NEUTRAL")] | length) as $ok
      | ([$x[] | select(. == "FAILURE" or . == "TIMED_OUT" or . == "CANCELLED" or . == "STALE")] | length) as $fail
      | ($c | length) as $total
      | "\($repo) #\(.number) · \(.title | .[0:60]) · \($ok)/\($total) · "
        + (if $fail > 0 then "ROJA (\($fail))"
           elif $total - $ok - $fail > 0 then "EN MARCHA"
           elif $total == 0 then "SIN CHECKS"
           else "VERDE" end)'
  ) > "$tmp/$(echo "$wt" | tr / _)" &
done
wait

# Dos worktrees en la misma rama = mismo PR: sort -u por (repo, número).
out=$(cat "$tmp"/* 2>/dev/null | sort -u -t'#' -k1,1 -k2,2n)
[ -n "$out" ] && echo "$out"

# Worktrees sin PR abierto (el archivo sale vacío cuando gh falló).
for wt in "${wts[@]}"; do
  f="$tmp/$(echo "$wt" | tr / _)"
  [ -s "$f" ] && continue
  branch=$(git -C "$wt" branch --show-current 2>/dev/null) || continue
  [ -n "$branch" ] || continue
  repo=$(git -C "$wt" config --get remote.origin.url 2>/dev/null | sed -E 's#.*[/:]##; s#\.git$##')
  [ -n "$repo" ] && echo "$repo · $branch · sin PR"
done | sort -u
