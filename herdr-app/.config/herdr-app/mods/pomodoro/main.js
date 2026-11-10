// A pomodoro timer with two interfaces: Simple (focus, short break, long
// break after every 4th) and Session (a saved list of focus and break steps
// that run one after another). The timer itself is in ./timer.js.
// Open it with mod.open:pomodoro (a window), pane.split {mod: "pomodoro"}, as a
// layout block with props {panel: true} (a side panel card) or {compact: true}
// (a small timer that opens the panel).

import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, settings, props, shared, setShared, closeOverlay, notify, playSound, nextCommand, layout, run, agents } from "herdr";
import { KEY, PHASES, DEFAULT_MINUTES, ROUNDS, ACTIONS, load, save, remaining, untouched, clock, hours, focusedSoFar,
  finish, sessions, saveSessions, summary, stepMin, lengthsOf, clone, MAX_MINUTES } from "./timer.js";
import { away, track, dismiss, name } from "./away.js";

const KEYED = ["toggle", "reset", "skip", "stop", "more", "less"];
const ORDER = ["focus", "short", "long"];
const HIDE_STEPS = "pomodoro.hideSteps";
const RING = 176;
const STRIP = 12;
const hhmm = (time) => { const d = new Date(time); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const icon = (name) => `mods/pomodoro/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Pomodoro extends View {
  init(_props, cx) {
    // The tab bar remembers each space's open panel, but only panels listed here.
    const panels = shared("workspace.panels");
    if (props()?.panel && Array.isArray(panels) && !panels.includes("pomodoro")) setShared("workspace.panels", [...panels, "pomodoro"]);
    this.tab = null;
    this.editing = null;
    this.name = InputState.new({ placeholder: "Session name" });
    this.name.on("change", () => this.edit((se) => { se.name = this.name.value(); }));
    // Settings: one number field per phase length.
    this.settings = false;
    this.lengths = {};
    for (const phase of ORDER) {
      const input = InputState.new({ placeholder: String(DEFAULT_MINUTES[phase]) });
      input.on("change", () => {
        const min = parseInt(input.value(), 10);
        if (min > 0 && min !== load().minutes[phase]) this.act("minutes", { phase, min });
      });
      input.on("blur", () => input.set_value(String(load().minutes[phase])));
      this.lengths[phase] = input;
    }
    this.awayTab = null;
    this.tick();
    cx.timer.every(1000, (cx) => {
      const running = this.tick();
      track(load());
      if (running || away()?.to === null) cx.notify();
    });
    // keys.json: "pomodoro.toggle" | reset | skip | stop | more | less. Every shown
    // copy gets the key, so one press acts once: copies drop a repeat within 150 ms.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (KEYED.includes(c)) this.act(c, undefined, true);
        cx.notify();
      }
    });
  }

  // Finishes a phase whose time is up (whichever copy sees it first) and
  // says whether the clock is running, so the copy redraws its seconds.
  tick() {
    const s = load();
    if (shared(KEY) && s.day !== shared(KEY).day) save(s);
    if (!s.running) return false;
    if (Date.now() < s.endsAt) return true;
    const toast = finish(s, Date.now());
    save(s);
    if (toast) {
      if (!toast.late) playSound("done");
      notify({ title: toast.title, body: toast.body, level: toast.level, timeout: 8000 });
    }
    return s.running;
  }

  act(name, arg, key = false) {
    this.tick();
    const s = load();
    const now = Date.now();
    if (key) {
      if (s.cmd && s.cmd.name === name && now - s.cmd.at < 150) return;
      s.cmd = { name, at: now };
    }
    ACTIONS[name](s, now, arg);
    save(s);
  }

  // Changes the session being edited, in the saved list. Built-ins never are.
  edit(change) {
    const list = sessions().map((se) => ({ ...se, steps: se.steps.map((st) => ({ ...st })) }));
    const se = list.find((x) => x.id === this.editing && !x.builtin);
    if (!se) return;
    change(se, list);
    saveSessions(list.filter((x) => !x.deleted));
  }

  open(id, name) {
    this.editing = id;
    this.name.set_value(name);
  }

  create() {
    const list = sessions();
    const id = `s${Date.now()}`, name = `Session ${list.filter((x) => !x.builtin).length + 1}`;
    saveSessions([...list, { id, name, v: 2, steps: [{ phase: "focus", min: null }, { phase: "short", min: null }] }]);
    this.open(id, name);
  }

  // A built-in's editable copy, opened in the editor.
  copy(se) {
    const list = sessions(), copy = clone(se, list);
    saveSessions([...list, copy]);
    this.open(copy.id, copy.name);
  }

  // Shows the Pomodoro panel in the layout's side panel, or hides it if it's showing.
  togglePanel() {
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === "pomodoro")) return run("mod.open", { name: "pomodoro" });
    if (!panel.hidden && body.active === "pomodoro") return run("layout.hide", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "pomodoro" });
    run("layout.show", { id: "panel" });
  }

  render() {
    const p = props() ?? {};
    if (p.compact) return this.chip();
    const t = theme();
    const s = load();
    const now = Date.now();
    const tab = this.tab ?? (s.run ? "session" : "simple");
    const focusedToday = s.focusMs + (s.running ? focusedSoFar(s, now) : 0);
    const ui = this.kit(t);

    const tabs = h_flex().p(3).gap(2).rounded(8).bg(t.raised).self_center().children(["simple", "session"].map((k) =>
      ui.press(div().id(`tab-${k}`).px(14).py(4).rounded(6).cursor_pointer()
        .when(tab === k, (el) => el.bg(t.background).text_color(t.foreground))
        .when(tab !== k, (el) => el.text_color(t.muted).hover((st) => st.text_color(t.foreground)))
        .on_click((_e, cx) => { this.tab = k; cx.notify(); })
        .child(k === "simple" ? "Simple" : "Session"))));
    const content = this.settings ? [this.config(t, s, ui)]
      : [tabs, tab === "simple" ? this.simple(t, s, ui) : s.run ? this.running(t, s, ui) : this.editing && sessions().some((x) => x.id === this.editing && !x.builtin) ? this.editor(t, s, ui) : this.list(t, s, ui)];
    const agentsView = !this.settings && (tab === "simple" || s.run) ? this.away(t, s, ui, now) : null;
    if (agentsView) content.push(agentsView);
    const gear = ui.small("settings", svg(icon("gear")).size(13).when(this.settings, (el) => el.text_color(t.foreground)), () => this.toggleSettings());
    const dots = this.strip(t, s);
    const today = `${hours(focusedToday)} focused today`;
    const idle = untouched(s);

    // In the side panel: a card like Files and Changes.
    if (p.panel) {
      return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
        .text_size(12).text_color(t.foreground)
        .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().text_size(13).font_semibold().child("Pomodoro"))
          .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
            .child(s.running ? "Running" : idle ? "Ready" : "Paused"))
          .child(div().flex_1())
          .child(gear)
          .child(ui.small("close", svg(icon("x")).size(13), () => run("layout.hide", { id: "panel" }))))
        .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(14).children(content))
        .child(h_flex().flex_none().px(14).h(36).items_center().gap(8).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
          .child(dots).child(div().flex_1()).child(today));
    }

    const overlay = p.overlay;
    return v_flex().id("root").size_full().min_w(240).p(14).gap(12).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(h_flex().items_center().child(gear).child(div().flex_1().flex().justify_center().when(!this.settings, (el) => el.child(tabs)))
        .child(overlay ? ui.small("close", svg(icon("x")).size(13), () => closeOverlay(overlay)) : div().w(22)))
      .children(content.slice(this.settings ? 0 : 1))
      .child(h_flex().items_center().gap(6).text_size(11).text_color(t.muted).child(dots).child(div().flex_1()).child(today));
  }

  // Today in tomatoes: one per finished focus, in fours, the gap where a long
  // break falls. Past STRIP they turn into a count.
  strip(t, s) {
    const n = s.sessions, shown = Math.min(n, STRIP);
    const groups = Array.from({ length: Math.ceil(shown / ROUNDS) }, (_, g) =>
      h_flex().gap(2).children(Array.from({ length: Math.min(ROUNDS, shown - g * ROUNDS) }, () =>
        div().relative().size(15).flex_none()
          .child(svg(icon("tomato")).absolute().inset_0().size(15).text_color(t.ansi1 ?? t.accent))
          .child(svg(icon("calyx")).absolute().inset_0().size(15).text_color(t.ansi2 ?? t.done)))));
    if (!n) return div().text_color(t.muted).child("No focus finished yet");
    return h_flex().items_center().gap(6).children(groups)
      .when(n > shown, (el) => el.child(div().text_color(t.muted).child(`+${n - shown}`)));
  }

  toggleSettings() {
    this.settings = !this.settings;
    const { minutes } = load();
    if (this.settings) for (const phase of ORDER) this.lengths[phase].set_value(String(minutes[phase]));
  }

  // Each phase's length for Simple and for new session steps; 25 / 5 / 15 unless changed.
  config(t, s, ui) {
    const step = (phase, delta) => {
      this.act("minutes", { phase, min: load().minutes[phase] + delta });
      this.lengths[phase].set_value(String(load().minutes[phase]));
    };
    const changed = ORDER.some((phase) => s.minutes[phase] !== DEFAULT_MINUTES[phase]);
    return v_flex().gap(12)
      .child(v_flex().gap(3)
        .child(div().text_size(13).font_semibold().child("Lengths"))
        .child(div().text_size(11).text_color(t.muted).child("For Simple and every session step that isn't pinned. Pinned steps (Deep work, 52 / 17) keep their own.")))
      .child(v_flex().gap(4).children(ORDER.map((phase) =>
        h_flex().h(34).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.border)
          .child(svg(icon(phase)).size(14).text_color(t[PHASES[phase].color] ?? t.accent))
          .child(div().flex_1().min_w(0).truncate().child(PHASES[phase].label))
          .when(s.minutes[phase] !== DEFAULT_MINUTES[phase], (el) => el.child(div().text_size(10).text_color(t.muted).child(`default ${DEFAULT_MINUTES[phase]}`)))
          .child(ui.small(`len-less-${phase}`, "−", () => step(phase, -1)))
          .child(ui.press(div().id(`len-${phase}`).w(40).h(24).px(6).flex().items_center().rounded(5)
            .border_1().border_color(t.input).cursor_text().font_family(settings().font_family ?? "JetBrains Mono")
            .child(Input.new(this.lengths[phase]).h_full().text_size(12).text_color(t.foreground))))
          .child(ui.small(`len-more-${phase}`, "+", () => step(phase, 1)))
          .child(div().w(24).text_size(11).text_color(t.muted).child("min")))))
      .child(h_flex().gap(8).items_center()
        // Disabled (dim, no pointer, no click) while the lengths are already the defaults.
        .child(ui.press(div().id("defaults").py(6).text_size(11).text_color(t.dim)
          .when(changed, (el) => el.cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.act("defaults");
              for (const phase of ORDER) this.lengths[phase].set_value(String(DEFAULT_MINUTES[phase]));
              cx.notify();
            }))
          .child(`Restore defaults (${ORDER.map((p) => DEFAULT_MINUTES[p]).join(" / ")})`)))
        .child(div().flex_1())
        .child(ui.button("settings-done", "Done", true, () => { this.settings = false; })));
  }

  // Shared bits of UI. Controls stop the press, so a window is dragged only by its background.
  kit(t) {
    const press = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    return {
      press,
      button: (id, label, primary, onClick) =>
        press(h_flex().id(id).h(30).px(12).gap(6).items_center().justify_center().rounded(7).cursor_pointer()
          .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
          .hover((st) => st.opacity(0.88)).on_click((_e, cx) => { onClick(); cx.notify(); }).children([].concat(label))),
      small: (id, label, onClick) =>
        press(h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { onClick(); cx.notify(); }).child(label)),
    };
  }

  // The big clock, its progress bar and (Simple, before it starts) −/+ for its length.
  // The clock inside the tomato ring. During a break, the time you're due back.
  clockFace(t, s, ui, adjustable) {
    const left = remaining(s);
    return [
      h_flex().items_center().justify_center().gap(8)
        .child(ui.small("less", adjustable ? "−" : "", () => this.act("less")))
        .child(div().relative().size(RING).flex_none()
          .children(this.ring(t, s, left))
          .child(div().absolute().inset_0().flex().items_center().justify_center()
            .text_size(40).font_semibold().font_family(settings().font_family ?? "JetBrains Mono")
            .text_color(s.running ? t.foreground : t.muted).child(clock(left))))
        .child(ui.small("more", adjustable ? "+" : "", () => this.act("more"))),
      ...(s.phase !== "focus" && s.running
        ? [div().text_center().text_size(12).text_color(t.muted).child(`Back at ${hhmm(s.endsAt)}`)] : []),
    ];
  }

  // A tomato seen from above: the track, the time left draining clockwise from
  // twelve in the phase's color (faded while paused), and the calyx at twelve.
  ring(t, s, left) {
    const c = RING / 2, r = c - 16, w = 5;
    const color = t[PHASES[s.phase].color] ?? t.accent;
    const paint = s.running ? color : Background.solid(color).opacity(0.45);
    const point = (turn) => [c + r * Math.sin(turn * 2 * Math.PI), c - r * Math.cos(turn * 2 * Math.PI)];
    const half = point(0.5);
    const track = PathBuilder.stroke(w).move_to(c, c - r)
      .arc_to(r, r, 0, false, true, half[0], half[1]).arc_to(r, r, 0, false, true, c, c - r).build();
    const f = Math.min(1, Math.max(0, left / s.total));
    const end = point(Math.min(f, 0.9999));
    let arc = PathBuilder.stroke(w).move_to(c, c - r);
    if (f > 0.5) arc = arc.arc_to(r, r, 0, false, true, half[0], half[1]);
    // Green leaves lying along the ring and a stem curling up between them,
    // always at full color: the ring is the tomato whatever the phase.
    const top = c - r, green = t.ansi2 ?? t.done;
    const leaf = (dir) => PathBuilder.fill().move_to(c, top)
      .curve_to(c + dir * 19, top + 1, c + dir * 8, top - 10)
      .curve_to(c, top, c + dir * 10, top + 6).close().build();
    const stem = PathBuilder.stroke(3).move_to(c, top + 1).curve_to(c + 5, top - 13, c - 1, top - 9).build();
    const layer = (path, bg) => window.paint_path(path, bg).absolute().top(0).left(0).size(RING);
    return [
      layer(track, t.raised),
      ...(f > 0 ? [layer(arc.arc_to(r, r, 0, false, true, end[0], end[1]).build(), paint)] : []),
      layer(leaf(-1), green),
      layer(leaf(1), green),
      layer(stem, green),
    ];
  }

  simple(t, s, ui) {
    const phases = h_flex().items_center().justify_center().gap(4)
      .children(ORDER.map((key) =>
        ui.press(h_flex().id(`phase-${key}`).px(8).py(3).gap(5).items_center().rounded(6).cursor_pointer()
          .when(s.phase === key && !s.run, (el) => el.bg(t.selected))
          .text_color(s.phase === key && !s.run ? t.foreground : t.muted)
          .hover((st) => st.bg(t.hover)).on_click(() => this.act("pick", key))
          .child(svg(icon(key)).size(12).text_color(s.phase === key && !s.run ? t[PHASES[key].color] ?? t.accent : t.dim))
          .child(PHASES[key].label))));
    return v_flex().gap(14)
      .child(phases)
      .when(Boolean(s.run), (el) => el.child(div().text_size(11).text_color(t.muted).text_center()
        .child(`Session “${s.run.name}” is running. Picking a phase ends it.`)))
      .children(this.clockFace(t, s, ui, !s.run && untouched(s)))
      .child(h_flex().gap(8).justify_center()
        .child(ui.button("toggle", s.running ? "Pause" : untouched(s) ? "Start" : "Resume", true, () => this.act("toggle")))
        .child(ui.button("reset", "Reset", false, () => this.act("reset")))
        .child(ui.button("skip", "Skip", false, () => this.act("skip"))));
  }

  // A session in progress: its clock and the steps still to go (finished ones
  // drop off), the current one marked. The list can be hidden; every copy follows.
  running(t, s, ui) {
    const { name, steps, step } = s.run;
    const hidden = Boolean(shared(HIDE_STEPS));
    const toggle = ui.press(h_flex().id("steps-toggle").h(22).px(6).gap(4).items_center().rounded(5).cursor_pointer()
      .text_size(11).text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { setShared(HIDE_STEPS, !hidden); cx.notify(); })
      .child(hidden ? "Show" : "Hide").child(svg(icon(hidden ? "down" : "up")).size(12)));
    return v_flex().gap(14)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(name))
        .child(div().text_size(11).text_color(t.muted).child(`Step ${step + 1} of ${steps.length}`)))
      .children(this.clockFace(t, s, ui, false))
      .child(h_flex().gap(8).justify_center()
        .child(ui.button("toggle", s.running ? "Pause" : "Resume", true, () => this.act("toggle")))
        .child(ui.button("skip", "Skip", false, () => this.act("skip")))
        .child(ui.button("stop", "End session", false, () => this.act("stop"))))
      .child(v_flex().gap(4)
        .child(h_flex().items_center().gap(6)
          .child(div().text_size(12).font_semibold().child("Next steps"))
          .child(div().text_size(11).text_color(t.muted).child(`${steps.length - step} left`))
          .child(div().flex_1())
          .child(toggle))
        .when(!hidden, (el) => el.child(v_flex().gap(2).children(steps.slice(step).map((st, n) => {
          const now = n === 0;
          return h_flex().h(26).px(8).gap(8).items_center().rounded(6)
            .when(now, (el) => el.bg(t.selected))
            .text_color(now ? t.foreground : t.muted)
            .child(svg(icon(st.phase)).size(13).text_color(now ? t[PHASES[st.phase].color] ?? t.accent : t.muted))
            .child(div().flex_1().child(PHASES[st.phase].label))
            .child(div().text_color(t.muted).child(`${now ? s.total / 60000 : stepMin(s.minutes, st)} min`));
        })))));
  }

  // Under the clock from the start of a break until dismissed or the next break:
  // the agents that need you, and the ones that finished while you were away.
  // A row opens the agent's pane.
  away(t, s, ui, now) {
    const a = away();
    if (!a || a.dismissed) return null;
    const live = agents();
    const byAddress = new Map(live.map((x) => [x.address, x]));
    // Newest first in both lists, so what just happened rises to the top.
    const blocked = live.filter((x) => x.status === "blocked")
      .sort((x, y) => (a.blocked[y.address] ?? 0) - (a.blocked[x.address] ?? 0));
    const finished = Object.entries(a.finished).sort(([, x], [, y]) => y.at - x.at)
      .map(([address, f]) => ({ ...f, agent: byAddress.get(address) }));
    const tab = this.awayTab ?? (blocked.length || !finished.length ? "blocked" : "finished");
    const pic = (p) => !p?.icon ? div().size(14).flex_none()
      : p.tint ? svg(p.icon).size(14).flex_none().text_color(t.muted) : image(p.icon).w(14).h(14).flex_none();
    const row = (id, x, label, space, right) => ui.press(h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(6)
      .when(Boolean(x), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => run("pane.focus", { pane: x.pane })))
      .child(pic(x?.program))
      .child(h_flex().flex_1().min_w(0).gap(6).items_baseline()
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(x ? t.foreground : t.muted).child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(space ?? "")))
      .child(right));
    const empty = (text) => div().py(6).text_size(11).text_color(t.muted).text_center().child(text);

    const list = tab === "blocked"
      ? blocked.map((x) => row(`away-${x.address}`, x, name(x), x.space_name, h_flex().gap(6).items_center()
        .child(div().text_size(11).text_color(t.muted).child(a.blocked[x.address] ? `since ${hhmm(a.blocked[x.address])}` : "before break"))
        .child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked)
          .flex().items_center().child("Needs you"))))
      : finished.map((f, i) => row(`away-done-${i}`, f.agent, f.agent ? name(f.agent) : f.name, f.agent?.space_name ?? f.space,
        h_flex().gap(6).items_center()
          .child(div().text_size(11).text_color(t.muted).child(f.agent ? hhmm(f.at) : `${hhmm(f.at)} · closed`))
          // Filled until you've looked at it, like the agents list.
          .child(div().size(7).rounded(4).when(f.agent?.status === "done", (el) => el.bg(t.done))
            .when(f.agent?.status !== "done", (el) => el.border(1.5).border_color(t.dim)))));

    const tabs = h_flex().p(3).gap(2).rounded(8).bg(t.raised).children([["blocked", "Needs you", blocked.length], ["finished", "Finished", finished.length]]
      .map(([k, label, n]) => ui.press(h_flex().id(`away-tab-${k}`).flex_1().px(10).py(3).gap(6).items_center().justify_center().rounded(6).cursor_pointer()
        .text_size(11).when(tab === k, (el) => el.bg(t.background).text_color(t.foreground))
        .when(tab !== k, (el) => el.text_color(t.muted).hover((st) => st.text_color(t.foreground)))
        .on_click((_e, cx) => { this.awayTab = k; cx.notify(); })
        .child(label)
        .when(n > 0, (el) => el.child(div().px(5).rounded(4).text_size(10).font_semibold()
          .bg((k === "blocked" ? t.blocked : t.done) + "26").text_color(k === "blocked" ? t.blocked : t.done).child(String(n)))))));

    // What happened, in counts, under a title that says whether you're still away.
    const working = Object.keys(a.working).length;
    const told = [a.to == null ? `since ${hhmm(a.from)}` : `${hhmm(a.from)} to ${hhmm(a.to)}`,
      blocked.length ? `${blocked.length} waiting on you` : null,
      finished.length ? `${finished.length} wrapped up` : null].filter(Boolean).join(" · ");
    const quiet = tab === "blocked" ? "No agent is waiting on you."
      : a.to != null ? "No agent finished while you were away."
      : working ? `${working} still working. They'll land here when they finish.` : "No agent is working right now.";
    return v_flex().gap(8).pt(12).border_t(1).border_color(t.border)
      .child(h_flex().items_start().gap(6)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12).font_semibold().child(a.to == null && s.phase !== "focus" ? "While you're on break" : "While you were away"))
          .child(div().text_size(11).text_color(t.muted).child(told)))
        .child(ui.small("away-dismiss", svg(icon("x")).size(12), () => { dismiss(); this.awayTab = null; })))
      .child(tabs)
      .child(v_flex().gap(2).children(list)
        .when(!list.length, (el) => el.child(empty(quiet))));
  }

  list(t, s, ui) {
    const list = sessions();
    return v_flex().gap(6)
      .children(list.map((se) => h_flex().id(`session-${se.id}`).px(10).py(8).gap(8).items_center().rounded(8)
        .border_1().border_color(t.border)
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().truncate().text_size(13).font_semibold().child(se.name || "Untitled"))
            .when(Boolean(se.locked), (el) => el.child(svg(icon("pin")).size(11).flex_none().text_color(t.muted)))
            .when(Boolean(se.builtin), (el) => el.child(div().flex_none().px(5).rounded(4).border_1().border_color(t.border)
              .text_size(10).text_color(t.muted).child("Built-in"))))
          .child(h_flex().gap(3).items_center()
            .children(se.steps.slice(0, 12).map((st) => svg(icon(st.phase)).size(11).text_color(t[PHASES[st.phase].color] ?? t.accent)))
            .child(div().pl(4).text_size(11).text_color(t.muted).child(summary(se, s.minutes)))))
        .child(se.builtin
          ? ui.button(`clone-${se.id}`, [svg(icon("copy")).size(12), "Clone"], false, () => this.copy(se))
          : ui.small(`edit-${se.id}`, svg(icon("pen")).size(13), () => this.open(se.id, se.name)))
        .child(ui.button(`start-${se.id}`, svg(icon("play")).size(12), true, () => {
          this.act("begin", se);
          this.tab = "session";
        }))))
      .when(!list.length, (el) => el.child(div().py(6).text_color(t.muted).text_center().child("No sessions yet")))
      .child(h_flex().justify_center().pt(4)
        .child(ui.button("new", [svg(icon("plus")).size(13), "New session"], false, () => this.create())));
  }

  editor(t, s, ui) {
    const se = sessions().find((x) => x.id === this.editing && !x.builtin);
    const set = (i, change) => this.edit((x) => change(x.steps[i], x.steps));
    const lengths = lengthsOf(se, s.minutes);
    const locked = Boolean(se.locked);
    const add = (phase) => this.edit((x) => x.steps.push({ phase, min: null }));
    const lock = () => this.edit((x) => {
      if (x.locked) delete x.locked;
      else x.locked = { ...load().minutes };
    });
    // −/+ gives a step its own length; ↺ makes it follow Settings again.
    const nudge = (i, up) => set(i, (x) => {
      const min = stepMin(lengths, x);
      x.min = up ? Math.min(MAX_MINUTES, min < 5 ? min + 1 : min + 5) : Math.max(1, min > 5 ? min - 5 : min - 1);
    });
    return v_flex().gap(10)
      .child(h_flex().items_center().justify_between()
        .child(ui.press(h_flex().id("back").h(26).pl(4).pr(10).gap(4).items_center().rounded(6).cursor_pointer()
          .text_color(t.muted).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.editing = null; cx.notify(); })
          .child(svg(icon("back")).size(14)).child("Sessions")))
        .child(ui.press(h_flex().id("lock").h(26).px(8).gap(5).items_center().rounded(6).cursor_pointer().border_1()
          .border_color(locked ? t.accent : t.border).text_color(locked ? t.accent : t.muted)
          .hover((x) => x.bg(t.hover)).on_click((_e, cx) => { lock(); cx.notify(); })
          .child(svg(icon("pin")).size(12)).child(locked ? "Times locked" : "Lock times"))))
      .child(ui.press(div().id("name").w_full().h(30).px(10).flex().items_center().rounded(7)
        .border_1().border_color(t.input).cursor_text()
        .child(Input.new(this.name).h_full().text_size(13).text_color(t.foreground))))
      .child(v_flex().gap(2).children(se.steps.map((st, i) =>
        h_flex().h(30).px(4).gap(4).items_center().rounded(6).hover((x) => x.bg(t.hover))
          .child(ui.small(`phase-${i}`, svg(icon(st.phase)).size(13).text_color(t[PHASES[st.phase].color] ?? t.accent), () => set(i, (x) => {
            x.phase = ORDER[(ORDER.indexOf(x.phase) + 1) % ORDER.length];
          })))
          .child(div().flex_1().min_w(0).truncate().child(PHASES[st.phase].label))
          .child(locked ? div().w(22).flex_none() : ui.small(`less-${i}`, "−", () => nudge(i, false)))
          .child(div().w(42).text_center().font_family(settings().font_family ?? "JetBrains Mono")
            .text_color(locked || st.min != null ? t.foreground : t.muted).child(`${stepMin(lengths, st)}m`))
          .child(locked ? div().w(22).flex_none() : ui.small(`more-${i}`, "+", () => nudge(i, true)))
          .child(locked || st.min == null ? div().w(22).flex_none()
            : ui.small(`follow-${i}`, svg(icon("reset")).size(12), () => set(i, (x) => { x.min = null; })))
          .child(ui.small(`up-${i}`, svg(icon("up")).size(13), () => set(i, (_x, all) => { if (i > 0) [all[i - 1], all[i]] = [all[i], all[i - 1]]; })))
          .child(ui.small(`down-${i}`, svg(icon("down")).size(13), () => set(i, (_x, all) => { if (i < all.length - 1) [all[i + 1], all[i]] = [all[i], all[i + 1]]; })))
          .child(ui.small(`remove-${i}`, svg(icon("x")).size(13), () => this.edit((x) => x.steps.splice(i, 1)))))))
      .when(!se.steps.length, (el) => el.child(div().py(4).text_color(t.muted).text_center().child("Add a step to begin")))
      .when(se.steps.length > 0, (el) => el.child(div().text_size(11).text_color(t.muted)
        .child(locked ? "Times are locked. Settings changes won't affect them."
          : "Grey times follow Settings. −/+ sets a step's own time; ↺ undoes it.")))
      .child(h_flex().gap(6).justify_center()
        .children(ORDER.map((phase) => ui.button(`add-${phase}`, [svg(icon(phase)).size(12).text_color(t[PHASES[phase].color] ?? t.accent), `+ ${PHASES[phase].label}`], false, () => add(phase)))))
      .child(h_flex().items_center().gap(8).pt(4).border_t(1).border_color(t.border)
        .child(ui.press(div().id("delete").py(6).text_size(11).text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.blocked))
          .on_click((_e, cx) => { this.edit((x) => { x.deleted = true; }); this.editing = null; cx.notify(); }).child("Delete session")))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.muted).child(summary(se, lengths)))
        .when(se.steps.length > 0, (el) => el.child(ui.button("start", [svg(icon("play")).size(12), "Start"], true, () => {
          this.editing = null;
          this.act("begin", se);
        }))));
  }

  // The tab bar's corner: the phase's icon and the time left, in the phase's color while it runs.
  // A click opens or closes the panel.
  chip() {
    const t = theme();
    const s = load();
    const color = t[PHASES[s.phase].color] ?? t.accent;
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "pomodoro";
    // On a break, how many agents are waiting on you, pinned to the phase icon.
    const waiting = s.phase === "focus" ? 0 : agents().filter((x) => x.status === "blocked").length;
    return h_flex().id("root").size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("chip").h(26).px(8).gap(6).flex_none().items_center().rounded(6).cursor_pointer()
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(s.running ? t.foreground : t.muted)
        .hover((st) => st.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.togglePanel())
        .child(div().relative().size(14).flex_none()
          .child(svg(icon(s.phase)).size(14).text_color(s.running ? color : t.muted))
          .when(waiting > 0, (el) => el.child(div().absolute().top(-6).right(-7).min_w(13).h(13).px(3).rounded(7)
            .bg(t.blocked).border_1().border_color(t.chrome).flex().items_center().justify_center()
            .text_size(9).font_bold().text_color(t.background).child(String(waiting)))))
        .child(div().font_family(settings().font_family ?? "JetBrains Mono").child(clock(remaining(s)))));
  }
}
