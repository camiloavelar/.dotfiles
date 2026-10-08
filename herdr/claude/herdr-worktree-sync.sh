#!/usr/bin/env bash
# Keep herdr workspaces in sync with git worktrees that Claude creates/removes,
# so they show up nested under their repo in the herdr sidebar.
#
# Claude Code keeps creating and removing its own worktrees (so .worktreeinclude,
# baseRef and branch cleanup still apply); this script only observes and never
# fails the hook it runs in.
#
# Modes (see ~/.claude/settings.json):
#   pre   PreToolUse/Bash:  snapshot worktrees before a worktree add/remove
#                           command
#   post  PostToolUse/Bash: open worktrees the command added, close workspaces
#                           of removed ones
#   sync  SessionStart, SubagentStart/Stop, PostToolUse/EnterWorktree|
#         ExitWorktree: open Claude's own worktrees (<repo>/.claude/worktrees/*:
#         --worktree, EnterWorktree, subagent isolation) and close workspaces
#         whose checkout is gone
#
# Workspaces are opened with a single shell tab and no focus. herdr-worktrunk
# treats a workspace without an nvim tab as stale and rebuilds it with the full
# layout the first time you open it from the picker.

set -uo pipefail

mode="${1:?usage: herdr-worktree-sync.sh pre|post|sync}"
payload="$(cat)"
state_dir="${XDG_RUNTIME_DIR:-$HOME/.cache}/claude-herdr-worktree"
log="$HOME/.claude/hooks/herdr-worktree-sync.log"

add_re='worktree[[:space:]]+add|(^|[^[:alnum:]_-])wt[[:space:]].*switch'
rm_re='worktree[[:space:]]+(remove|prune)|(^|[^[:alnum:]_-])wt[[:space:]].*remove'

[[ ${HERDR_ENV:-} == 1 ]] && command -v herdr >/dev/null 2>&1 || exit 0

say() { printf '%s %s %s\n' "$(date +%FT%T)" "$mode" "$*" >>"$log"; }

label_for() { basename "$1" | tr './' '__'; }

# The pane running this Claude session; never close the workspace it lives in.
own_workspace="${HERDR_PANE_ID%%:*}"

open_worktree() {
  local repo_root=$1 path=$2 out
  if out=$(herdr worktree open --cwd "$repo_root" --path "$path" \
    --label "$(label_for "$path")" --no-focus 2>&1); then
    say "opened $path ($(jq -r '.result.workspace.workspace_id // "?"' <<<"$out" 2>/dev/null))"
  else
    say "open failed $path: $out"
  fi
}

# Checkout paths that already have a herdr workspace.
open_paths() {
  herdr workspace list | jq -r '.result.workspaces[].worktree.checkout_path // empty'
}

# Close every linked-worktree workspace whose checkout no longer exists.
close_orphans() {
  local ws path
  while IFS=$'\t' read -r ws path; do
    [[ -n $ws && ! -d $path && $ws != "$own_workspace" ]] || continue
    herdr workspace close "$ws" >/dev/null 2>&1 && say "closed $ws ($path)"
  done < <(herdr workspace list | jq -r \
    '.result.workspaces[] | select(.worktree.is_linked_worktree) | "\(.workspace_id)\t\(.worktree.checkout_path)"')
}

# Directories the command may have operated on: the hook cwd plus any
# `cd <dir>` / `git -C <dir>` targets.
candidate_dirs() {
  local cwd=$1 cmd=$2 d
  printf '%s\n' "$cwd"
  grep -oE '(^|[;&|[:space:]])(cd|-C)[[:space:]]+[^[:space:];&|]+' <<<"$cmd" \
    | sed -E 's/^[;&|[:space:]]*(cd|-C)[[:space:]]+//; s/^["'\'']//; s/["'\'']$//' \
    | while read -r d; do
      d="${d/#\~/$HOME}"
      [[ $d == /* ]] || d="$cwd/$d"
      printf '%s\n' "$d"
    done
}

# "<repo root>\t<worktree path>" for every worktree of the repos the given
# directories belong to, one line each, sorted.
worktrees_of() {
  local seen=$'\n' dir common
  while read -r dir; do
    common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
    [[ $seen != *$'\n'"$common"$'\n'* ]] || continue
    seen+="$common"$'\n'
    git -C "$dir" worktree list --porcelain \
      | awk -v r="$(dirname "$common")" '/^worktree /{ print r "\t" substr($0, 10) }'
  done | sort -u
}

tool_use_id() {
  local id
  id=$(jq -r '.tool_use_id // empty' <<<"$payload")
  [[ $id =~ ^[A-Za-z0-9_-]+$ ]] && printf '%s' "$id"
}

cwd=$(jq -r '.cwd // empty' <<<"$payload")
cwd="${cwd:-$PWD}"

case "$mode" in
pre)
  cmd=$(jq -r '.tool_input.command // empty' <<<"$payload")
  grep -qE "$add_re|$rm_re" <<<"$cmd" || exit 0
  id=$(tool_use_id) || exit 0
  mkdir -p -m 700 "$state_dir" && [[ -O $state_dir ]] || exit 0
  candidate_dirs "$cwd" "$cmd" | worktrees_of >"$state_dir/$id"
  ;;

post)
  id=$(tool_use_id) || exit 0
  marker="$state_dir/$id"
  [[ -f $marker ]] || exit 0
  cmd=$(jq -r '.tool_input.command // empty' <<<"$payload")

  while IFS=$'\t' read -r repo_root path; do
    open_worktree "$repo_root" "$path"
  done < <(comm -13 "$marker" <(candidate_dirs "$cwd" "$cmd" | worktrees_of))
  rm -f "$marker"

  grep -qE "$rm_re" <<<"$cmd" && close_orphans
  ;;

sync)
  already=$(open_paths)
  while IFS=$'\t' read -r repo_root path; do
    [[ $path == "$repo_root/.claude/worktrees/"* ]] || continue
    grep -qxF "$path" <<<"$already" || open_worktree "$repo_root" "$path"
  done < <(printf '%s\n' "$cwd" ${CLAUDE_PROJECT_DIR:+"$CLAUDE_PROJECT_DIR"} | worktrees_of)
  close_orphans
  ;;
esac

exit 0
