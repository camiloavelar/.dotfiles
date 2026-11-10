# Installing this Herdr app config

This folder is the personal part of `~/.config/herdr-app` for the Herdr desktop app:
keys, settings, the `Workbench` layout, the `tokyo-night` theme and 11 mods.
`sync.sh` copies it in (`install`) and back out (`capture`); its header lists exactly
which files it carries and why they are copied, not stowed.

## Steps

1. **Herdr is there.** `herdr-app status` prints JSON (not an error). Done when it does;
   if it doesn't, stop: the person installs and opens the Herdr app first.
2. **Tell the person what changes, then wait for their go.** `install` replaces
   `keys.json` and `settings.json` whole and every listed mod folder (old files are kept
   as `<name>.bak-<time>`). Compare first: `diff -u ~/.config/herdr-app/keys.json
   herdr-app/.config/herdr-app/keys.json` (and the same for `settings.json`), and
   `ls ~/.config/herdr-app/mods` for mods of the same name that would be replaced.
   If the machine's `keys.json` has keys the repo's lacks, merge them into the repo's
   copy instead of letting `install` drop them. Then relay the mods' reach (below).
   Done when the person has agreed.
3. **Install.** `./herdr-app/sync.sh install` from the repo root. Done when it prints
   `installed into …` and its `herdr-app status` excerpt shows `"errors": []`.
4. **Check every mod.** `herdr-app check ~/.config/herdr-app/mods/<name>` for each name
   in `sync.sh`'s `MODS`. Done when every one prints `check passed`.
5. **Show the layout.** `herdr-app do layout.switch --name Workbench`, then
   `herdr-app status` and `herdr-app shot /tmp/workbench.png`; look at the picture. Done
   when `"layout": "Workbench"`, `"errors": []`, and the shot has the grouped Spaces and
   Agents sidebar, the tab bar with Files / Changes / Simulator / 🍅 and the ports button
   bottom right.
6. **Hand over** the person's part (below), and what you skipped or saw fail.

## What the mods reach (tell the person in step 2)

- `spaces-grouped`: network. Asks each repo's `origin` host API (GitHub through the
  person's `gh` login, else GitLab/Forgejo anonymously) for the owner picture; runs
  `git`, `ssh -G`, `gh`, `curl`, `file`. Pictures land in its hidden `.cache/`.
- `agents-grouped`: runs `git rev-parse` in each space's folder.
- `live-ports`: runs `lsof` every 4s; its Stop button runs `kill` with no confirmation.
- `pomodoro`: runs `osascript` to post a macOS notification when a phase ends.
- `herdr-sim`: runs `xcrun simctl`, `adb`, and `npx serve-sim@0.1.49` (downloads from
  npm on first use); its Android stream serves frames on 127.0.0.1 without auth.
- `sessionizer`: runs `find` on `~/projects` and `~/personal`, and `git rev-parse`.
- `prefix`, `space-nav`, `agent-nav`, `herdr-sim-screen`, `tabs-herdr-sim`: none.

## The person's part

- `gh auth login` for private repos' pictures (public ones work without it).
- macOS notifications allowed for "Script Editor" (System Settings › Notifications),
  for the Pomodoro's.
- `~/projects` and `~/personal` hold the folders `ctrl+b f` lists.
- `ctrl+b` is the prefix; `ctrl+b` then a key does the rest (table in
  `mods/prefix/main.js`). It takes `ctrl+b` from shells and nvim.

## Watch out

- The layout's name is the file's: `Workbench`, capital W, in `layout.switch` and in
  `keys.json`'s `"layout:Workbench"` section.
- The mods are frozen copies (several cloned from Herdr's shipped `spaces`, `agents`,
  `tabs`): Herdr updates never touch them. Herdr's own mods and layouts stay out of this
  repo and are rewritten by Herdr on every start.
- Changes are made in `~/.config/herdr-app`, then `./herdr-app/sync.sh capture` brings
  them here for review and commit. Editing this folder alone changes nothing on screen.
- `~/.config/herdr-app/AGENTS.md` (written by Herdr) is the guide to layouts, keys and
  the mod API.
