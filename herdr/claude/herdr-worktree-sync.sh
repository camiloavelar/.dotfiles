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
#
# The pane of the Claude session that created a worktree moves into a new tab
# of that worktree's workspace, once per session (later worktrees only open):
#   post   when the command added exactly one worktree; Claude is then told to
#          call EnterWorktree, since moving the pane does not change its cwd
#   sync   after EnterWorktree, and at SessionStart when the cwd is already a
#          linked worktree (--worktree)
# Never for subagents (their worktrees are background work) or ExitWorktree.

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

session_id=$(jq -r '.session_id // empty' <<<"$payload")
[[ $session_id =~ ^[A-Za-z0-9_-]+$ ]] || session_id=
agent_id=$(jq -r '.agent_id // empty' <<<"$payload")
event=$(jq -r '.hook_event_name // empty' <<<"$payload")
tool=$(jq -r '.tool_name // empty' <<<"$payload")

# "<pane id>\t<workspace id>\t<focused>" of this session's pane. Looked up by
# session id: the pane gets a new id when it moves, so $HERDR_PANE_ID goes stale.
own_pane() {
  [[ -n $session_id ]] || return 1
  herdr pane list | jq -er --arg s "$session_id" \
    'first(.result.panes[] | select(.agent_session.value == $s))
     | "\(.pane_id)\t\(.workspace_id)\t\(.focused)"'
}

# The workspace this session's pane lives in; close_orphans never closes it.
own_workspace=$(own_pane 2>/dev/null | cut -f2) || true
own_workspace="${own_workspace:-${HERDR_PANE_ID%%:*}}"

workspace_for() {
  herdr workspace list | jq -er --arg p "$1" \
    'first(.result.workspaces[] | select(.worktree.checkout_path == $p) | .workspace_id)'
}

# Move this session's pane into a new tab of the workspace for worktree $1.
# Only the first worktree of a session gets the pane; subagents never move it.
move_pane_to() {
  local path=$1 marker ws pane cur focused focus out
  [[ -z $agent_id && -n $session_id ]] || return 1
  mkdir -p -m 700 "$state_dir" && [[ -O $state_dir ]] || return 1
  marker="$state_dir/moved-$session_id"
  [[ ! -e $marker ]] || return 1
  ws=$(workspace_for "$path") || { say "move: no workspace for $path"; return 1; }
  IFS=$'\t' read -r pane cur focused < <(own_pane) || { say "move: no pane for $session_id"; return 1; }
  [[ $cur != "$ws" ]] || { touch "$marker"; return 1; }
  [[ $focused == true ]] && focus=--focus || focus=--no-focus
  if out=$(herdr pane move "$pane" --workspace "$ws" --new-tab --label claude "$focus" 2>&1); then
    touch "$marker"
    say "moved $pane to $ws ($path)"
  else
    say "move failed $pane to $ws: $out"
    return 1
  fi
}

# The linked worktree containing $1, if any.
linked_worktree_of() {
  local top common
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  common=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [[ $top != "$(dirname "$common")" ]] && printf '%s\n' "$top"
}

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

  added=$(comm -13 "$marker" <(candidate_dirs "$cwd" "$cmd" | worktrees_of))
  rm -f "$marker"
  while IFS=$'\t' read -r repo_root path; do
    [[ -n $path ]] && open_worktree "$repo_root" "$path"
  done <<<"$added"

  # One new worktree: move the pane there and have Claude follow with its cwd.
  if [[ -n $added && $added != *$'\n'* ]] && move_pane_to "${added#*$'\t'}"; then
    jq -n --arg e "$event" --arg p "${added#*$'\t'}" '{hookSpecificOutput: {
      hookEventName: $e,
      additionalContext: "herdr moved this session'\''s pane into the workspace of the new worktree \($p). Call EnterWorktree with path \($p) now so your cwd matches it."
    }}'
  fi

  grep -qE "$rm_re" <<<"$cmd" && close_orphans
  ;;

sync)
  already=$(open_paths)
  while IFS=$'\t' read -r repo_root path; do
    [[ $path == "$repo_root/.claude/worktrees/"* ]] || continue
    grep -qxF "$path" <<<"$already" || open_worktree "$repo_root" "$path"
  done < <(printf '%s\n' "$cwd" ${CLAUDE_PROJECT_DIR:+"$CLAUDE_PROJECT_DIR"} | worktrees_of)

  if [[ $event == SessionStart || ($event == PostToolUse && $tool == EnterWorktree) ]]; then
    # EnterWorktree may name a worktree outside .claude/worktrees.
    entered=$(jq -r '.tool_input.path // empty' <<<"$payload")
    entered="${entered/#\~/$HOME}"
    if wt=$(linked_worktree_of "${entered:-$cwd}") || wt=$(linked_worktree_of "$cwd"); then
      common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)
      workspace_for "$wt" >/dev/null || open_worktree "$(dirname "$common")" "$wt"
      move_pane_to "$wt"
    fi
  fi
  close_orphans
  ;;
esac

exit 0
