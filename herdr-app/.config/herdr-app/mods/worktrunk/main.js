// Worktree switcher for the focused folder's repo, opened by prefix+t (port of
// ~/.local/scripts/herdr-worktrunk, built on worktrunk's `wt`).
// Lists the repo's worktrees; enter goes to a worktree's space, or makes one there
// running claude. Typing filters; the first row creates a worktree for the typed branch.
// Arrows or ctrl-j/k/n/p move, enter opens, esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, spaces, panes, focused, run, theme, props, closeOverlay } from "herdr";

const MAX = 60; // rows shown

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const inside = (path, dir) => Boolean(path) && (path === dir || path.startsWith(`${dir}/`));

// The old script's space name: the folder's basename, dots and slashes as underscores.
const nameOf = (dir) => dir.split("/").pop().replace(/[./]/g, "_");

function age(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

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

export default class Worktrunk extends View {
  init(_props, cx) {
    this.root = null;      // the repo's top folder
    this.list = null;      // wt list entries, null while loading
    this.error = null;
    this.busy = null;      // what's running ("Creating feat/x…")
    this.filter = "";
    this.at = 0;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Filter, or type a new branch…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value().trim(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.rows()[this.at], cx));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    cx.spawn(async (cx) => {
      const f = focused();
      const sp = spaces().find((s) => s.id === f?.space);
      const cwd = f?.cwd || (sp && place(sp, panes())) || home();
      const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
      if (g?.code !== 0) {
        this.error = `Not in a git repository (${cwd.replace(home(), "~")})`;
        return cx.notify();
      }
      this.root = g.stdout.trim();
      await this.load();
      cx.notify();
    });
  }

  async load() {
    const r = await exec("wt", ["list", "--format=json"], { cwd: this.root }).catch((e) => ({ code: -1, stderr: String(e) }));
    if (r.code !== 0) {
      this.error = `wt list failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`;
      this.list = [];
      return;
    }
    this.list = JSON.parse(r.stdout);
  }

  // The space showing each worktree: a space belongs to the worktree whose path is the
  // longest prefix of where it is (a worktree can live inside the main checkout).
  spaceFor() {
    const ps = panes();
    const paths = (this.list ?? []).map((w) => w.path);
    const out = {};
    for (const s of spaces().filter((s) => !s.machine)) {
      const at = s.folder && paths.includes(s.folder) ? s.folder : place(s, ps);
      const best = paths.filter((p) => inside(at, p)).sort((a, b) => b.length - a.length)[0];
      if (best && !out[best]) out[best] = s;
    }
    return out;
  }

  // The create row first (with whatever is typed), then worktrees best match first.
  rows() {
    if (!this.list) return [];
    const q = this.filter;
    const exact = this.list.some((w) => w.branch === q);
    const create = { create: true, branch: q && !exact ? q : "" };
    const sp = this.spaceFor();
    const wts = this.list
      .map((w) => ({ w, s: score(`${w.branch ?? ""} ${w.path.split("/").pop()}`, q) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s - b.s || (b.w.is_main ? 1 : 0) - (a.w.is_main ? 1 : 0))
      .slice(0, MAX)
      .map(({ w }) => ({ w, space: sp[w.path] }));
    return [create, ...wts];
  }

  close() {
    closeOverlay(props().overlay);
  }

  enter(path, space) {
    this.close();
    if (space) run("space.select", { id: space.id });
    else run("space.new", { name: nameOf(path), folder: path, argv: ["claude"] });
  }

  pick(r, cx) {
    if (!r || this.busy) return;
    if (!r.create) return this.enter(r.w.path, r.space);
    const branch = r.branch;
    if (!branch) return;
    if (branch.startsWith("-") || /\s/.test(branch)) {
      this.error = "A branch name can't start with - or contain spaces";
      return cx.notify();
    }
    this.busy = `Creating ${branch}…`;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      // --no-cd: the space is opened here; hooks still run. Up to 10 min for slow hooks.
      const c = await exec("wt", ["--yes", "switch", "--create", branch, "--no-cd"], { cwd: this.root, timeout: 600000 })
        .catch((e) => ({ code: -1, stderr: String(e) }));
      this.busy = null;
      if (c.code !== 0) {
        this.error = `wt switch --create failed: ${(c.stderr || c.stdout || "").trim().split("\n").pop()}`;
        return cx.notify();
      }
      await this.load();
      const w = this.list.find((x) => x.branch === branch);
      if (!w) {
        this.error = `Created ${branch}, but wt list doesn't show it`;
        return cx.notify();
      }
      this.enter(w.path, null);
    });
  }

  render(cx) {
    const t = theme();
    const list = this.rows();
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const repo = this.root ? this.root.split("/").pop() : "";
    const row = (r, i) => {
      const base = h_flex().id(`wt-${i}`).h(26).px(8).gap(8).items_center().rounded(5)
        .when(i === this.at, (el) => el.bg(t.selected))
        .on_click((_e, cx) => this.pick(r, cx));
      if (r.create) {
        return base.child(div().w(14).text_color(t.accent).child("+"))
          .child(div().flex_1().truncate().text_color(r.branch ? t.foreground : t.dim)
            .child(r.branch ? `New worktree: ${r.branch}` : "New worktree (type a branch name)"));
      }
      const w = r.w;
      const label = w.branch ?? `${w.path.split("/").pop()} (detached)`;
      return base
        .child(div().w(14).text_color(t.dim).child(w.is_main ? "●" : ""))
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(r.space ? t.foreground : t.muted).child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${age(w.commit?.timestamp ?? 0)} · ${(w.commit?.message ?? "").split("\n")[0]}`))
        .when(Boolean(r.space), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")));
    };
    return v_flex()
      .id("worktrunk")
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
      .child(h_flex().items_center().gap(8)
        .child(div().font_semibold().text_color(t.foreground).child("Worktrees"))
        .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(repo))
        .child(div().text_size(11).text_color(t.dim).child("↑↓  enter  esc")))
      .child(h_flex().h(34).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.busy), (el) => el.child(h_flex().px(8).gap(8).items_center().text_color(t.muted)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900))
        .child(this.busy)))
      .when(Boolean(this.error), (el) => el.child(div().px(8).text_size(12).text_color(t.blocked).child(this.error)))
      .when(!this.list && !this.error, (el) => el.child(div().px(8).text_color(t.dim).child("Loading worktrees…")))
      .child(v_flex().id("worktrunk-list").children(list.map(row)));
  }
}
