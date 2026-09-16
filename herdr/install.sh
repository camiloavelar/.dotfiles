#!/usr/bin/env bash
# Install this repo's herdr config and scripts, and the herdr fork binary when
# no herdr is on PATH (or with --binary).
#
# herdr here is the camiloavelar/herdr fork of herdrdev/herdr. It adds prefix+a
# agent navigation and ui.navigation_preview, and serves its own updates from
# its GitHub releases: the preview channel (set in config.toml) follows every
# push to master; `herdr update` from outside herdr installs the next build.
#
# The config is COPIED, not symlinked: herdr and its plugins write the file
# through rename, which would replace a symlink into this repo.
#
# Idempotent. An existing config that differs from the base is backed up first.

set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
base="$repo/.config/herdr/config.toml"
config_target="$HOME/.config/herdr/config.toml"
scripts_src="$repo/../bin/.local/scripts"
scripts_dir="$HOME/.local/scripts"
fork="camiloavelar/herdr"
preview_base="https://github.com/$fork/releases/download/preview"
bin_dir="$HOME/.local/bin"

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

fork_asset() {
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64) echo herdr-macos-aarch64 ;;
        Darwin-x86_64) echo herdr-macos-x86_64 ;;
        Linux-x86_64) echo herdr-linux-x86_64 ;;
        Linux-aarch64 | Linux-arm64) echo herdr-linux-aarch64 ;;
        *) return 1 ;;
    esac
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# Download the current preview build of the fork into ~/.local/bin/herdr,
# verified against the sha256 published in preview.json.
install_fork_binary() {
    local asset
    asset=$(fork_asset) || { echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1; }
    local expected
    expected=$(curl -fsSL "$preview_base/preview.json" | python3 -c '
import json, sys
print(json.load(sys.stdin)["assets"][sys.argv[1]]["sha256"])
' "${asset#herdr-}")
    local tmp
    tmp=$(mktemp)
    curl -fsSL "$preview_base/$asset" -o "$tmp"
    local actual
    actual=$(sha256_of "$tmp")
    if [[ $actual != "$expected" ]]; then
        rm -f "$tmp"
        echo "sha256 mismatch for $asset: expected $expected, got $actual" >&2
        exit 1
    fi
    chmod +x "$tmp"
    mkdir -p "$bin_dir"
    mv -f "$tmp" "$bin_dir/herdr"
    echo "  installed $bin_dir/herdr ($("$bin_dir/herdr" --version))"
    echo "           restart the server to run it: herdr server stop && herdr"
}

echo "binary:"
if [[ ${1:-} == --binary ]] || ! command -v herdr >/dev/null 2>&1; then
    install_fork_binary
    export PATH="$bin_dir:$PATH"
else
    herdr_path=$(command -v herdr)
    herdr_version=$(herdr --version 2>/dev/null || true)
    if [[ $herdr_version != *preview* ]]; then
        echo "  WARNING  $herdr_path is '$herdr_version', not a fork preview build."
        echo "           Remove the upstream install (brew uninstall herdr / mise uninstall herdr /"
        echo "           rm $herdr_path), then rerun this script, or run it with --binary to"
        echo "           install the fork into $bin_dir/herdr."
    else
        echo "  ok       $herdr_path ($herdr_version)"
    fi
fi

echo
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
if have_plugin hhdebb.herdr-radar; then
    echo "  REMOVE   hhdebb.herdr-radar rewrites the sidebar and theme blocks this config owns:"
    echo "             herdr plugin uninstall hhdebb.herdr-radar"
fi

echo
echo "agent integrations:"
# The hooks that tell herdr what an agent is doing; without them every sidebar
# row sits at "unknown". They ship inside the herdr binary (no build, no
# third-party code), so installing one is not a decision worth stopping for.
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
echo "reloading a running server (no-op if none):"
herdr server reload-config >/dev/null 2>&1 && echo "  reloaded" || echo "  no running server"
