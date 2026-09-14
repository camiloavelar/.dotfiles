#!/usr/bin/env bash
# Install this repo's herdr config and scripts.
#
# The config is COPIED, not symlinked, and `herdr` is deliberately not a stow
# package. The herdr-radar plugin rewrites ~/.config/herdr/config.toml through
# writeFileSync + renameSync, and a rename over a symlink replaces it with a
# regular file -- so any symlink here survives only until the plugin next
# touches the theme. A copy makes that a no-op.
#
# The plugin's three managed blocks are therefore NOT tracked: they carry
# absolute, machine-specific paths. This script copies the clean base and then
# asks the plugin to append them locally -- then drops the [ui.sidebar.spaces]
# table out of them, because this config keeps herdr's own Spaces panel (see
# drop_radar_spaces). TOML forbids a second declaration of the same table and
# radar refuses to write anything while one of its tables sits outside its
# markers, so the base config must never declare a [ui.sidebar.*] of its own.
#
# Idempotent. An existing config that differs from the base is backed up first.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
base="$repo/.config/herdr/config.toml"
config_target="$HOME/.config/herdr/config.toml"
scripts_src="$repo/../bin/.local/scripts"
scripts_dir="$HOME/.local/scripts"
radar="hhdebb.herdr-radar"

link() {
    local src=$1 dst=$2

    mkdir -p "$(dirname "$dst")"

    if [[ -L $dst && $(readlink "$dst") == "$src" ]]; then
        echo "  ok       $dst"
        return
    fi
    if [[ -e $dst && ! -L $dst ]]; then
        local backup="$dst.bak.$(date +%Y%m%d%H%M%S)"
        mv "$dst" "$backup"
        echo "  backup   $backup"
    fi

    ln -sfn "$src" "$dst"
    echo "  linked   $dst -> $src"
}

have_plugin() {
    herdr plugin list --json 2>/dev/null | grep -q "$1"
}

# Report a plugin, never install it: a GitHub install builds and runs code, so
# it stays a decision rather than a side effect of running this script.
require_plugin() {
    local id=$1 source=$2 why=$3
    shift 3

    if have_plugin "$id"; then
        echo "  ok       $id"
        return
    fi

    echo "  MISSING  $why needs $id:"
    echo "             herdr plugin install $source"
    local note
    for note in "$@"; do
        echo "$note"
    done
}

# Hand the Spaces panel back to herdr. Radar writes [ui.sidebar.spaces] inside
# its sidebar block -- a state mark and a vendor logo per Space -- and has no
# setting to leave it alone; this config wants herdr's own panel there.
#
# DELETING the table is what restores herdr's defaults, whatever they are in
# the installed version. Writing herdr's rows in its place is what an earlier
# version of this script did, and that pinned the panel to one guess at those
# defaults. A copy of the table OUTSIDE the markers is not an option either:
# radar refuses to write any block at all while one of its tables sits outside
# them (foreignTables), so the Agents rows would go down with it.
#
# Runs last, after the daemon restart below: apply(), the settings popup and a
# daemon start that finds a stale logo variant each rewrite the whole block.
drop_radar_spaces() {
    python3 - "$config_target" <<'SPACES'
import sys

path = sys.argv[1]
text = open(path).read()
start = text.find("\n[ui.sidebar.spaces]")
end = text.find("# <<< herdr-radar sidebar block")
if start < 0 or end < 0 or start > end:
    print("  ok       no [ui.sidebar.spaces] in the radar block")
    sys.exit(0)
open(path, "w").write(text[: start + 1] + text[end:])
print("  dropped  [ui.sidebar.spaces] -- herdr's own Spaces rows show again")
SPACES
}

if ! command -v herdr >/dev/null 2>&1; then
    echo "herdr not found in PATH. Install it first:" >&2
    echo "  curl -fsSL https://herdr.dev/install.sh | sh" >&2
    exit 1
fi

echo "config:"
mkdir -p "$(dirname "$config_target")"
if [[ -L $config_target ]]; then
    # A leftover from the symlink era. Removing it first matters: cp writes
    # THROUGH a symlink, which would clobber whatever it points at.
    echo "  unlink   $config_target -> $(readlink "$config_target")"
    rm -f "$config_target"
elif [[ -e $config_target ]] && ! cmp -s "$base" "$config_target"; then
    backup="$config_target.bak.$(date +%Y%m%d%H%M%S)"
    cp "$config_target" "$backup"
    echo "  backup   $backup"
fi
cp "$base" "$config_target"
echo "  copied   $config_target"

echo
echo "scripts:"
link "$(cd "$scripts_src" && pwd)/herdr-sessionizer" "$scripts_dir/herdr-sessionizer"
link "$(cd "$scripts_src" && pwd)/herdr-worktrunk" "$scripts_dir/herdr-worktrunk"

echo
echo "validating config:"
herdr config check

echo
echo "plugins:"
require_plugin herdr-nvim-nav aimdevlee/herdr-nvim-nav \
    "ctrl+h/j/k/l pane navigation" \
    "         plus the Neovim side in ~/.config/nvim/lua/plugins/"
require_plugin herdr.auto-title kryptamine/herdr-auto-title \
    "automatic tab and pane titles" \
    "         builds with go, so Go has to be on the PATH herdr sees" \
    "         defaults are all this config wants; override them in" \
    "         ~/Library/Application Support/herdr-auto-title/config.env"

echo
echo "agent integrations:"
# The hooks that tell herdr what an agent is doing -- without them every
# sidebar row sits at "unknown" and radar has nothing to colour. Unlike the
# plugins above these are herdr's own, built into the binary: no build, no
# third-party code, so installing one is not a decision worth stopping for.
# `install` is idempotent and also upgrades a hook herdr reports as outdated.
for integration in claude; do
    # "claude: current (v9) (/path/to/hook)" -- the path is noise here
    state=$(herdr integration status | sed -n "s/^$integration: //p" | sed 's| (/.*||')
    case $state in
    current*)
        echo "  ok       $integration ($state)"
        ;;
    *)
        herdr integration install "$integration" >/dev/null
        echo "  installed $integration (was: ${state:-unknown})"
        ;;
    esac
done

echo
# Rewrites the managed blocks the copy above just removed, and reloads. Runs
# the plugin's script with this shell's node rather than as a server action:
# under a bare-PATH server the action fails silently, the sidebar block stays
# missing, and the plugin's daemon then reads that absence as "rows turned off"
# and never puts it back.
if have_plugin "$radar"; then
    echo "herdr-radar managed blocks:"
    radar_root=$(herdr plugin list --json | python3 -c '
import json, sys
for p in json.load(sys.stdin)["result"]["plugins"]:
    if p["plugin_id"] == sys.argv[1]:
        print(p["plugin_root"])
' "$radar")
    node "$radar_root/bin/configure.js" --apply --reload

    radar_config="$(herdr plugin config-dir "$radar")/config.toml"
    mkdir -p "$(dirname "$radar_config")"
    if ! grep -q '^follow_appearance' "$radar_config" 2>/dev/null; then
        echo 'follow_appearance = false' >> "$radar_config"
        echo "  set      follow_appearance = false in $radar_config"
        node "$radar_root/bin/agent-state.js" --stop
        node "$radar_root/bin/agent-state.js"
    fi

    drop_radar_spaces
    herdr server reload-config >/dev/null
else
    echo "  MISSING  agent sidebar needs the radar plugin:"
    echo "             herdr plugin install hhdebb/herdr-radar"
    echo
    echo "reloading a running server (no-op if none):"
    herdr server reload-config 2>/dev/null || echo "  no running server"
fi
