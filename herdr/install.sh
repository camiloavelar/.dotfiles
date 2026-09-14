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
# asks the plugin to append them locally.
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
if herdr plugin list --json 2>/dev/null | grep -q 'herdr-nvim-nav'; then
    echo "  ok       herdr-nvim-nav plugin installed"
else
    echo "  MISSING  ctrl+h/j/k/l pane navigation needs the navigator plugin:"
    echo "             herdr plugin install aimdevlee/herdr-nvim-nav"
    echo "           plus the Neovim side in ~/.config/nvim/lua/plugins/"
fi

echo
# Rewrites the managed blocks the copy above just removed, and reloads. Needs a
# running server; with none, the blocks land on the next run of this script.
if herdr plugin list --json 2>/dev/null | grep -q "$radar"; then
    echo "herdr-radar managed blocks:"
    herdr plugin action invoke "$radar.configure" >/dev/null
    echo "  invoked  $radar.configure (writes tab-bar, sidebar, theme blocks)"
else
    echo "  MISSING  agent sidebar needs the radar plugin:"
    echo "             herdr plugin install hhdebb/herdr-radar"
    echo
    echo "reloading a running server (no-op if none):"
    herdr server reload-config 2>/dev/null || echo "  no running server"
fi
