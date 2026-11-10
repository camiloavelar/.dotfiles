#!/usr/bin/env bash
# Sync this repo's Herdr app config with ~/.config/herdr-app (or $HERDR_APP_HOME).
#
#   ./herdr-app/sync.sh install   repo -> machine (files that differ are backed up first)
#   ./herdr-app/sync.sh capture   machine -> repo (after changing things in the app)
#
# Files are COPIED, not symlinked: Herdr loads mod code through a symlink but doesn't
# see edits behind it, won't load icons from outside its home, and rewrites
# settings.json and layouts itself.
#
# Only personal files are kept: keys, settings, the Workbench layout, the black and tokyo-night
# themes and the mods listed below. Herdr's own mods and layouts, and everything it
# generates (*.d.ts, jsconfig.json, AGENTS.md, view/shared/window.json, caches,
# simulator frames), stay out.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.config/herdr-app
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

FILES=(keys.json settings.json layouts/Workbench.json themes/black.json themes/tokyo-night.json)
MODS=(prefix space-nav agent-nav agents-grouped spaces-grouped sessionizer
      worktrunk live-ports pomodoro tasks herdr-sim herdr-sim-screen tabs-herdr-sim)
EXCLUDES=(--exclude '*.d.ts' --exclude jsconfig.json --exclude .cache/ --exclude '*.jpg'
          --exclude '*.bak*' --exclude '*.error')

copy() { # copy <from root> <to root> [rsync options...]
    local from=$1 to=$2 f m
    shift 2
    for f in "${FILES[@]}"; do
        mkdir -p "$(dirname "$to/$f")"
        rsync -a "$@" "$from/$f" "$to/$f"
    done
    for m in "${MODS[@]}"; do
        mkdir -p "$to/mods/$m"
        rsync -a --delete "${EXCLUDES[@]}" "$@" "$from/mods/$m/" "$to/mods/$m/"
    done
}

# Herdr docks a new mod whose mod.json has a "place" other than "none" by wrapping the
# shown layout in a new root. Root-only fields (titlebar, traffic_lights, background,
# terminal_padding) then stop applying and the macOS title bar comes back as its own row.
check_layout() { # check_layout <layout file>
    command -v python3 >/dev/null || return 0
    python3 - "$1" <<'EOF' || true
import json, sys
d = json.load(open(sys.argv[1]))
if d.get("id") != "root" or d.get("titlebar") != "none":
    print(f"WARNING: {sys.argv[1]}: its root isn't the real root (id {d.get('id')!r}, titlebar "
          f"{d.get('titlebar')!r}). A docked mod probably wrapped it: move the original root "
          f"(the child with id 'root') back to the top and put the mod's block inside it.",
          file=sys.stderr)
EOF
}

case "${1:-}" in
    install)
        # --backup keeps a file that differs as <name>.bak-<time> before replacing it.
        copy "$repo" "$home" --backup --suffix ".bak-$(date +%Y%m%d%H%M%S)" -i
        echo "installed into $home"
        check_layout "$home/layouts/Workbench.json"
        command -v herdr-app >/dev/null && herdr-app status 2>/dev/null | grep -A3 '"errors"' || true
        ;;
    capture)
        copy "$home" "$repo"
        echo "captured into $repo"
        check_layout "$repo/layouts/Workbench.json"
        git -C "$repo" status --short -- .
        ;;
    *)
        sed -n '2,6s/^# \{0,1\}//p' "$0"
        exit 2
        ;;
esac
