// Space/tab tree with vim keys (tmux choose-tree style), opened by prefix+w.
// j/k or arrows move, enter or l opens, esc or q closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, theme, props, closeOverlay } from "herdr";

function rows() {
  const out = [];
  for (const s of spaces()) {
    out.push({ kind: "space", space: s });
    for (const tab of s.tabs) if (!tab.settled) out.push({ kind: "tab", space: s, tab });
  }
  return out;
}

export default class SpaceNav extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
    const list = rows();
    const at = list.findIndex((r) => r.kind === "tab" && r.space.active && r.tab.active);
    this.at = at >= 0 ? at : 0;
  }

  close() {
    closeOverlay(props().overlay);
  }

  open(r) {
    this.close();
    if (!r) return;
    run("space.select", { id: r.space.id });
    if (r.kind === "tab") run("tab.select", { id: r.tab.id });
  }

  onKey(e, cx, list) {
    const k = e.keystroke;
    if (k === "j" || k === "down") this.at = Math.min(this.at + 1, list.length - 1);
    else if (k === "k" || k === "up") this.at = Math.max(this.at - 1, 0);
    else if (k === "enter" || k === "l") this.open(list[this.at]);
    else if (k === "escape" || k === "q") this.close();
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const list = rows();
    if (this.at >= list.length) this.at = Math.max(list.length - 1, 0);
    return v_flex()
      .id("space-nav")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx, list))
      .w_full()
      .p(12)
      .gap(2)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex().pb(6).items_center()
          .child(div().flex_1().font_semibold().text_color(t.foreground).child("Spaces"))
          .child(div().text_size(11).text_color(t.dim).child("j/k  enter  esc")))
      .child(
        v_flex().id("space-nav-list").children(
          list.map((r, i) => {
            const sel = i === this.at;
            const item = r.kind === "space" ? r.space : r.tab;
            const label = r.kind === "space" ? r.space.name : r.tab.named ? `${r.tab.index}: ${r.tab.name}` : String(r.tab.index);
            // tab.active is per space; only the shown space's tab is "current"
            const current = r.kind === "space" ? r.space.active : r.space.active && r.tab.active;
            return h_flex()
              .id(`sn-${i}`)
              .h(26)
              .px(8)
              .gap(8)
              .items_center()
              .rounded(5)
              .when(sel, (el) => el.bg(t.selected))
              .on_click(() => this.open(r))
              // spaces flush left; tabs indented with a fixed-width status dot column
              .when(r.kind === "tab", (el) => el
                .child(div().w(10))
                .child(div().size(6).rounded(3).bg(item.status ? t[item.status] : "#00000000")))
              .child(
                div().flex_1().truncate()
                  .when(r.kind === "space", (el) => el.font_semibold())
                  .text_color(current ? t.accent : t.muted)
                  .child(label));
          })));
  }
}
