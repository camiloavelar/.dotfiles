// Agent list grouped by space, with vim keys, opened by prefix+a.
// j/k or arrows move between agents, enter or l opens, esc or q closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, shared, run, theme, props, closeOverlay } from "herdr";

// Same tree as the sidebar (agents-grouped): repos together, main checkout first,
// worktree spaces nested under their repo. Repo info comes from agents-grouped via
// shared state; without it the list is grouped by space only.
function rows() {
  const repoOf = shared("agents.repoOf") ?? {};
  const spIdx = new Map(spaces().map((s, i) => [s.id, i]));
  const repoFirst = new Map();
  for (const [id, i] of spIdx) {
    const k = repoOf[id]?.repo ?? id;
    if (!repoFirst.has(k)) repoFirst.set(k, i);
  }
  const key = (a) => [repoFirst.get(repoOf[a.space]?.repo ?? a.space) ?? 0, repoOf[a.space]?.linked ? 1 : 0, spIdx.get(a.space) ?? 0];
  const list = [...agents()].sort((x, y) => {
    const [a, b] = [key(x), key(y)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });

  const out = [];
  let space = null;
  let repo;
  for (const a of list) {
    if (a.space === space) {
      out.push({ kind: "agent", agent: a, indent: out.at(-1).indent });
      continue;
    }
    space = a.space;
    const git = repoOf[a.space];
    const r = git?.repo ?? a.space;
    const nested = Boolean(git?.linked);
    const newRepo = r !== repo;
    repo = r;
    const gap = newRepo && out.length > 0;
    if (nested && newRepo) out.push({ kind: "space", name: git.name, indent: 0, gap });
    out.push({ kind: "space", name: a.space_name, indent: nested ? 12 : 0, gap: gap && !nested });
    out.push({ kind: "agent", agent: a, indent: nested ? 12 : 0 });
  }
  return out;
}

export default class AgentNav extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
    const list = rows();
    const at = list.findIndex((r) => r.kind === "agent" && r.agent.focused);
    this.at = at >= 0 ? at : list.findIndex((r) => r.kind === "agent");
  }

  close() {
    closeOverlay(props().overlay);
  }

  open(r) {
    this.close();
    if (r) run("agent.focus", { terminal: r.agent.address });
  }

  // next agent row from `from` in direction `step`, skipping space headers
  move(list, step) {
    for (let i = this.at + step; i >= 0 && i < list.length; i += step) {
      if (list[i].kind === "agent") return (this.at = i);
    }
  }

  onKey(e, cx, list) {
    const k = e.keystroke;
    if (k === "j" || k === "down") this.move(list, 1);
    else if (k === "k" || k === "up") this.move(list, -1);
    else if (k === "enter" || k === "l") this.open(list[this.at]);
    else if (k === "escape" || k === "q") this.close();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const list = rows();
    if (!list[this.at] || list[this.at].kind !== "agent") {
      this.at = list.findIndex((r) => r.kind === "agent");
    }
    return v_flex()
      .id("agent-nav")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx, list))
      .w_full()
      .p(12)
      .gap(2)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex().pb(6).items_center()
          .child(div().flex_1().font_semibold().text_color(t.foreground).child("Agents"))
          .child(div().text_size(11).text_color(t.dim).child("j/k  enter  esc")))
      .when(list.length === 0, (el) => el.child(div().px(8).text_color(t.dim).child("No agents running")))
      .child(
        v_flex().id("agent-nav-list").children(
          list.map((r, i) => {
            if (r.kind === "space") {
              return div().id(`an-${i}`).h(r.gap ? 38 : 26).px(8).pl(8 + r.indent).pt(r.gap ? 18 : 6).text_size(11).text_color(t.dim).child(r.name);
            }
            const a = r.agent;
            return h_flex()
              .id(`an-${i}`)
              .h(26)
              .px(8)
              .gap(8)
              .items_center()
              .rounded(5)
              .when(i === this.at, (el) => el.bg(t.selected))
              .on_click(() => this.open(r))
              .child(div().w(10 + r.indent))
              .child(div().size(6).rounded(3).bg(t[a.status] ?? t.unknown))
              .child(div().text_color(t.dim).child(String(a.tab_index)))
              .child(div().flex_1().truncate().text_color(a.focused ? t.accent : t.foreground).child(a.title.replace(/^[^\p{L}\p{N}]+/u, "").trim()))
              .child(div().text_color(t.muted).child(a.program.name))
              .child(div().text_size(11).text_color(t.dim).child(a.status));
          })));
  }
}
