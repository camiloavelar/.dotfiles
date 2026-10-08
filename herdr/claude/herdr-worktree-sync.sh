#!/usr/bin/env bash
# Keep herdr workspaces in sync with git worktrees that Claude creates/removes,
# so they show up nested under their repo in the herdr sidebar.
#
# Modes (see ~/.claude/settings.json):
#   pre     PreToolUse/Bash:  mark the start of a worktree add/remove command
#   post    PostToolUse/Bash: open new worktrees in herdr, close workspaces of
#                             removed ones
#   create  WorktreeCreate:   EnterWorktree / --worktree / subagent isolation
#   remove  WorktreeRemove
#
# Workspaces are opened with a single shell tab and no focus. herdr-worktrunk
# treats a workspace without an nvim tab as stale and rebuilds it with the full
# layout the first time you open it from the picker.

set -uo pipefail

mode="${1:?usage: herdr-worktree-sync.sh pre|post|create|remove}"
payload="$(cat)"
state_dir="${TMPDIR:-/tmp}/claude-herdr-worktree"
log="$HOME/.claude/hooks/herdr-worktree-sync.log"

add_re='worktree[[:space:]]+add|(^|[^[:alnum:]_-])wt[[:space:]].*switch'
rm_re='worktree[[:space:]]+(remove|prune)|(^|[^[:alnum:]_-])wt[[:space:]].*remove'

herdr_on() { [[ ${HERDR_ENV:-} == 1 ]] && command -v herdr >/dev/null 2>&1; }

say() { printf '%s %s %s\n' "$(date +%FT%T)" "$mode" "$*" >>"$log"; }

label_for() { basename "$1" | tr './' '__'; }

# The pane running this Claude session; never close the workspace it lives in.
own_workspace="${HERDR_PANE_ID%%:*}"

open_worktree() {
  local repo_root=$1 path=$2 out
  herdr_on || return 0
  if out=$(herdr worktree open --cwd "$repo_root" --path "$path" \
    --label "$(label_for "$path")" --no-focus 2>&1); then
    say "opened $path ($(jq -r '.result.workspace.workspace_id // "?"' <<<"$out" 2>/dev/null))"
  else
    say "open failed $path: $out"
  fi
}

close_worktree_workspace() {
  local path=$1 ws
  herdr_on || return 0
  ws=$(herdr workspace list | jq -r --arg p "$path" \
    'first(.result.workspaces[] | select(.worktree.checkout_path == $p and .worktree.is_linked_worktree) | .workspace_id) // empty')
  [[ -n $ws && $ws != "$own_workspace" ]] || return 0
  herdr workspace close "$ws" >/dev/null 2>&1 && say "closed $ws ($path)"
}

# Close every linked-worktree workspace whose checkout no longer exists.
close_orphans() {
  herdr_on || return 0
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

# GNU stat first: on Linux `stat -f` is filesystem info and would not fail.
birth_time() { stat -c %W "$1" 2>/dev/null || stat -f %B "$1" 2>/dev/null || echo 0; }

case "$mode" in
pre)
  grep -qE "$add_re|$rm_re" <<<"$payload" || exit 0
  id=$(jq -r '.tool_use_id // empty' <<<"$payload")
  [[ -n $id ]] || exit 0
  mkdir -p "$state_dir" && date +%s >"$state_dir/$id"
  ;;

post)
  id=$(jq -r '.tool_use_id // empty' <<<"$payload")
  marker="$state_dir/$id"
  [[ -n $id && -f $marker ]] || exit 0
  started=$(<"$marker")
  rm -f "$marker"

  cmd=$(jq -r '.tool_input.command // empty' <<<"$payload")
  cwd=$(jq -r '.cwd // empty' <<<"$payload")
  cwd="${cwd:-$PWD}"

  if grep -qE "$add_re" <<<"$cmd"; then
    seen=$'\n'
    while read -r dir; do
      common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
      [[ $seen != *$'\n'"$common"$'\n'* ]] || continue
      seen+="$common"$'\n'
      repo_root=$(dirname "$common")
      for admin in "$common"/worktrees/*/; do
        [[ -f $admin/gitdir ]] || continue
        (($(birth_time "$admin") >= started)) || continue
        open_worktree "$repo_root" "$(dirname "$(<"$admin/gitdir")")"
      done
    done < <(candidate_dirs "$cwd" "$cmd")
  fi

  grep -qE "$rm_re" <<<"$cmd" && close_orphans
  ;;

create)
  name=$(jq -r '.name' <<<"$payload")
  src=$(jq -r '.cwd // empty' <<<"$payload")
  src="${src:-${CLAUDE_PROJECT_DIR:-$PWD}}"
  say "payload $(jq -c . <<<"$payload")"

  # Resolve the main checkout even if src is itself a linked worktree.
  common=$(git -C "$src" rev-parse --path-format=absolute --git-common-dir) || exit 1
  repo_root=$(dirname "$common")
  path="$repo_root/.claude/worktrees/$name"
  branch="worktree-$name"

  if [[ ! -d $path ]]; then
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo_root" worktree add "$path" "$branch" >&2 || exit 1
    else
      # Claude's default baseRef "fresh": branch from origin/<default-branch>.
      base=$(git -C "$repo_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo HEAD)
      git -C "$repo_root" worktree add -b "$branch" "$path" "$base" >&2 || exit 1
    fi
  fi
  open_worktree "$repo_root" "$path"
  echo "$path"
  ;;

remove)
  path=$(jq -r '.worktree_path' <<<"$payload")
  say "payload $(jq -c . <<<"$payload")"
  close_worktree_workspace "$path"
  [[ -d $path ]] || exit 0
  git -C "$path" worktree remove "$path" >&2 || exit 1
  ;;
esac

exit 0
