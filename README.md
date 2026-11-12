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

## herdr-app (Herdr desktop app)

`herdr-app/.config/herdr-app/` holds the personal part of `~/.config/herdr-app`:
`keys.json`, `settings.json`, the `Workbench` layout, the `black` theme (`tokyo-night` kept too), and
these mods:

- `prefix`: `ctrl+b` then a key, ported from the TUI's `[keys]` (see the table in
  `mods/prefix/main.js`).
- `spaces-grouped`, `agents-grouped`: clones of Herdr's `spaces` and `agents` with
  keyboard navigation (`prefix+w`, `prefix+a`), worktrees nested under their repo,
  and repo owner pictures (from balcsida/herdr-profile-pictures).
- `space-nav`, `agent-nav`: popup fallbacks for those when the sidebar is hidden.
- `sessionizer`: `prefix+f`, folders in `~/projects` and `~/personal`, opens a space
  with `claude`.
- `worktrunk`: `prefix+t`, the focused repo's worktrees (worktrunk's `wt`); opens one's
  space or a new one with `claude`, or creates a worktree for a typed branch.
- `tasks`: a tab bar chip and side panel with the followed Claude agent's latest steps
  and its superpowers plan's progress.
- `eas-builds`: a tab bar chip and side panel with the focused repo's EAS builds (status,
  queue, time, current step from the log) and their store submissions.
- Third-party: `live-ports` (VladTemp27/herdr-mods), `pomodoro`
  (jsainthilaire/herdr-pomodoro), `herdr-sim`, `herdr-sim-screen`, `tabs-herdr-sim`.

`./herdr-app/sync.sh install` copies them into `~/.config/herdr-app` (files that
differ are kept as `.bak-<time>`); `./herdr-app/sync.sh capture` copies the
machine's current files back into the repo after changing things in the app.
Files are copied, not stowed: Herdr doesn't hot-reload code behind a symlink,
won't load icons from outside its home, and rewrites settings and layouts itself.
Herdr's own mods and generated files (`*.d.ts`, `AGENTS.md`, `view.json`,
`shared.json`, caches, simulator frames) are left out. An agent installing it on a
machine follows `herdr-app/AGENTS.md`.

### kitty

`kitty/kitty.conf` and `kitty/current-theme.conf` (Catppuccin Mocha) go to
`~/.config/kitty/`. Needs JetBrainsMono Nerd Font. The crust `background`
after the theme include makes pane interiors darker than the herdr sidebar.
