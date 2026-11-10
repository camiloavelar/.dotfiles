// tmux-style prefix: keys.json binds ctrl-b to `mod.open:prefix`. This popup
// takes the keyboard, runs the command for the next key, then closes.
// Ported from ~/.config/herdr/config.toml [keys].
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, run, theme, props, closeOverlay, layout, setShared } from "herdr";

// key -> [command, args]
const BINDS = {
  "m": ["pane.zoom"],
  "g": ["mod.open", { name: "picker" }],
  "s": ["mod.open", { name: "picker" }],
  "w": ["@nav", { mod: "spaces-grouped", token: "spaces.nav", popup: "space-nav" }],
  "shift-s": ["app.settings"],
  "[": ["terminal.search"], // closest thing to copy mode
  "shift-k": ["agent.prev"],
  "shift-j": ["agent.next"],
  "-": ["pane.split", { direction: "down" }],
  "minus": ["pane.split", { direction: "down" }],
  "v": ["pane.split", { direction: "right" }],
  "c": ["tab.new"],
  "f": ["mod.open", { name: "sessionizer" }],
  "a": ["@nav", { mod: "agents-grouped", token: "agents.nav", popup: "agent-nav" }],
  // unnamed, so tab lists show the agent's live title
  "shift-a": ["tab.new", { argv: ["claude"] }],
  "n": ["tab.next"],
  "p": ["tab.prev"],
  "q": ["window.close"], // detach: terminals keep running in herdr-core
  "space": ["layout.toggle", { id: "sidebar" }],
};
for (let i = 1; i <= 9; i++) BINDS[String(i)] = ["tab.select", { index: i }];

// prefix+shift+1..9 focuses the Nth agent; macOS may report the shifted char.
const SHIFTED = { "!": 1, "@": 2, "#": 3, "$": 4, "%": 5, "^": 6, "&": 7, "*": 8, "(": 9 };

// Is a mod's layout block on screen (present, no hidden ancestor)?
function modShown(mod, node = layout(), hidden = false) {
  if (!node) return false;
  const h = hidden || node.hidden === true;
  if (node.content?.mod === mod) return !h;
  return (node.children ?? []).some((c) => modShown(mod, c, h));
}

function agentIndex(e) {
  const m = /^shift-([1-9])$/.exec(e.keystroke);
  if (m) return Number(m[1]);
  return SHIFTED[e.keystroke] ?? SHIFTED[e.key_char] ?? null;
}

export default class Prefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(50, () => this.handle.focus());
  }

  close() {
    closeOverlay(props().overlay);
  }

  onKey(e, cx) {
    cx.stop_propagation();
    if (e.key === "shift" || e.key === "control" || e.key === "alt" || e.key === "cmd") return;
    this.close();
    const n = agentIndex(e);
    if (n !== null) {
      const a = agents()[n - 1];
      if (a) run("agent.focus", { terminal: a.address });
      return;
    }
    const bind = BINDS[e.keystroke];
    if (bind?.[0] === "@nav") {
      // keyboard cursor in a sidebar list; its popup when the sidebar isn't shown
      const { mod, token, popup } = bind[1];
      if (modShown(mod)) setShared(token, Date.now());
      else run("mod.open", { name: popup });
    } else if (bind) run(bind[0], bind[1] ?? {});
  }

  render(cx) {
    const t = theme();
    return h_flex()
      .id("prefix")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .size_full()
      .px(14)
      .gap(8)
      .items_center()
      .bg(t.popover)
      .text_size(13)
      .child(div().text_color(t.accent).font_semibold().child("ctrl-b"))
      .child(div().text_color(t.muted).child("waiting for key…"));
  }
}
