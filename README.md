# .dotfiles

## herdr (camiloavelar/herdr fork)

herdr runs from the fork at https://github.com/camiloavelar/herdr, not upstream.
The fork adds `prefix+a` agent-panel navigation and `ui.navigation_preview`,
and serves its own updates from GitHub releases. `herdr/.config/herdr/config.toml`
sets `[update] channel = "preview"`, which follows every push to the fork's
`master`.

### Migrate a machine from upstream herdr

1. Detach (`prefix+q`) and stop the server: `herdr server stop`.
2. Remove the upstream install: `brew uninstall herdr`, `mise uninstall herdr`,
   or `rm ~/.local/bin/herdr`. Keep `~/.config/herdr` and `~/.local/state/herdr`.
3. `./herdr/install.sh` — installs the fork binary into `~/.local/bin/herdr`
   (sha256-verified against the release manifest) when no `herdr` is on PATH,
   copies the config, links the popup scripts, validates, and lists the plugins
   to install (`aimdevlee/herdr-nvim-nav`, `kryptamine/herdr-auto-title`).
   Use `./herdr/install.sh --binary` to force the binary install.
4. `herdr` — the session restores. `herdr --version` shows
   `0.9.0-preview.<date>-<commit>`.

Later updates: `herdr update` from a terminal outside herdr. The in-app notice
appears by itself after each fork build.

### Claude worktrees in the sidebar

`herdr/claude/herdr-worktree-sync.sh` opens worktrees that Claude Code creates
as linked herdr spaces (nested under the repo, no focus, one shell tab) and
closes them when the checkout is removed. It covers Bash (`git worktree add`,
`wt switch`, `git worktree remove/prune`, `wt remove`) and Claude's own
worktrees (`EnterWorktree`, `--worktree`, subagent isolation). It only
observes: Claude still creates and removes its worktrees itself, so
`.worktreeinclude` and branch cleanup keep working. `herdr/install.sh`
links it into `~/.claude/hooks/` and registers the hooks in
`~/.claude/settings.json`. Log: `~/.claude/hooks/herdr-worktree-sync.log`.

### kitty

`kitty/kitty.conf` and `kitty/current-theme.conf` (Catppuccin Mocha) go to
`~/.config/kitty/`. Needs JetBrainsMono Nerd Font. The crust `background`
after the theme include makes pane interiors darker than the herdr sidebar.
