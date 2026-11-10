// tmux-sessionizer for Herdr, opened by prefix+f: pick a folder under ~/projects or
// ~/personal; go to its space, or make one there running claude.
// Typing filters (letters in order, like fzf); arrows or ctrl-j/k/n/p move, enter opens, esc closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, spaces, panes, run, theme, props, closeOverlay } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made
// (same rule as the spaces mod). `ps`: panes(), read once by the caller.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const inside = (path, dir) => Boolean(path) && (path === dir || path.startsWith(`${dir}/`));

const ROOTS = ["projects", "personal"];
const MAX = 60; // rows shown

// The old script's session name: the folder's basename with dots as underscores.
const nameOf = (dir) => dir.split("/").pop().replace(/\./g, "_");

// Subsequence match; lower is better (gaps between matched letters), null if no match.
function score(text, q) {
  if (!q) return 0;
  text = text.toLowerCase();
  let at = -1, gaps = 0;
  for (const ch of q.toLowerCase()) {
    const i = text.indexOf(ch, at + 1);
    if (i < 0) return null;
    if (at >= 0) gaps += i - at - 1;
    at = i;
  }
  return gaps;
}

export default class Sessionizer extends View {
  init(_props, cx) {
    this.dirs = [];
    this.filter = "";
    this.at = 0;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Open a project…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.open(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    cx.spawn(async (cx) => {
      const h = home();
      const r = await exec("find", ["-L", ...ROOTS.map((d) => `${h}/${d}`), "-mindepth", "1", "-maxdepth", "1", "-type", "d"]).catch(() => null);
      this.dirs = (r?.stdout ?? "").split("\n").filter(Boolean).sort();
      cx.notify();
      // Each dir's main checkout (from git's common dir), so worktrees group under their repo.
      this.main = {};
      await Promise.all(this.dirs.map(async (dir) => {
        const g = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir }).catch(() => null);
        const common = g?.code === 0 ? g.stdout.trim() : "";
        if (common.endsWith("/.git")) this.main[dir] = common.slice(0, -5);
      }));
      cx.notify();
    });
  }

  // The repo a dir belongs to when it's a worktree of another listed dir, else null.
  parentOf(dir) {
    const m = this.main?.[dir];
    return m && m !== dir && this.dirs.includes(m) ? m : null;
  }

  // Filtered dirs, best match first; each with the space already open there, if any.
  rows() {
    const h = home();
    const ps = panes();
    const sp = spaces().filter((s) => !s.machine).map((s) => ({ s, at: place(s, ps) }));
    const spaceIn = (dir) => (sp.find((x) => x.s.folder === dir) ?? sp.find((x) => inside(x.at, dir)))?.s;
    const scored = new Map(this.dirs.map((dir) => [dir, score(dir.replace(`${h}/`, ""), this.filter)]));
    // Groups: a repo and its worktrees. A group shows when any member matches; its repo row
    // always leads it. Groups go best match first, worktrees inside by match.
    const groups = new Map();
    for (const dir of this.dirs) {
      const key = this.parentOf(dir) ?? dir;
      if (!groups.has(key)) groups.set(key, []);
      if (key !== dir) groups.get(key).push(dir);
    }
    const best = (key) => Math.min(...[key, ...groups.get(key)].map((d) => scored.get(d) ?? Infinity));
    const out = [];
    for (const key of [...groups.keys()].filter((k) => best(k) < Infinity).sort((a, b) => best(a) - best(b))) {
      out.push({ dir: key, label: key.replace(`${h}/`, "~/"), child: false });
      const base = key.split("/").pop();
      for (const dir of groups.get(key).filter((d) => scored.get(d) !== null).sort((a, b) => scored.get(a) - scored.get(b))) {
        const name = dir.split("/").pop();
        out.push({ dir, label: name.startsWith(`${base}.`) ? name.slice(base.length + 1) : name, child: true });
      }
    }
    return out.slice(0, MAX).map((r) => ({ ...r, space: spaceIn(r.dir) }));
  }

  close() {
    closeOverlay(props().overlay);
  }

  open(r) {
    this.close();
    if (!r) return;
    if (r.space) run("space.select", { id: r.space.id });
    else run("space.new", { name: nameOf(r.dir), folder: r.dir, argv: ["claude"] });
  }

  render(cx) {
    const t = theme();
    const list = this.rows();
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    return v_flex()
      .id("sessionizer")
      .track_focus(this.handle)
      .w_full()
      .p(14)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") return this.close();
        if (k === "down" || k === "ctrl-j" || k === "ctrl-n") this.at = Math.min(this.at + 1, list.length - 1);
        else if (k === "up" || k === "ctrl-k" || k === "ctrl-p") this.at = Math.max(this.at - 1, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child("Projects"))
        .child(div().text_size(11).text_color(t.dim).child("↑↓  enter  esc")))
      .child(h_flex().h(34).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().id("sessionizer-list").children(list.map((r, i) =>
        h_flex()
          .id(`sz-${i}`)
          .h(26)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(5)
          .when(i === this.at, (el) => el.bg(t.selected))
          .on_click(() => this.open(r))
          .when(r.child, (el) => el.child(div().w(14).text_color(t.dim).child("└")))
          .child(div().flex_1().truncate().text_color(r.space ? t.foreground : t.muted).child(r.label))
          .when(Boolean(r.space), (el) => el.child(div().text_size(11).text_color(t.accent).child("open"))))))
      .when(this.dirs.length > 0 && list.length === 0, (el) => el.child(div().px(8).text_color(t.dim).child("No match")));
  }
}
