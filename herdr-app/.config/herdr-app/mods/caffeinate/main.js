// Shows and toggles `caffeinate` (keeps the Mac awake).
// Counted: runs with flags only (no -w, no command), open-ended or timed with -t of 10 minutes
// or more, so the short `caffeinate -i -t 300` other apps keep starting don't show. Any -d in the
// flags means the display stays on. A timed run ends by itself (caffeinate's own -t).
// props {compact: true}: tab bar chip. props {panel: true}: side panel with one toggle per mode.
// "Off" kills the counted processes; "on" starts one detached, so it outlives Herdr.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, settings, props, layout, run, shared, setShared } from "herdr";

const KEY = "caffeinate.state";
const ICON = "mods/caffeinate/cup.svg";
const MODES = [
  { id: "system", flag: "-i", label: "Sistema acordado", hint: "Impede o Mac de dormir; a tela pode apagar" },
  { id: "display", flag: "-d", label: "Tela acordada", hint: "Mantém a tela ligada (e o Mac acordado)" },
];
const short = { system: "Sistema", display: "Tela" };
const HOURS = [0, 1, 2, 3, 4, 8]; // presets; 0: until turned off
const MINS = "caffeinate.minutes"; // the chosen length in minutes, 0: until turned off
const MIN_T = 600; // shortest counted -t, and shortest length offered
// Typed length: "1h30", "2h", "45m", "1:30"; a bare number is minutes. null when unreadable.
function parse(text) {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  let m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = t.match(/^(?:(\d+)h)?(?:(\d+)(?:m|min)?)?$/);
  if (!t || !m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
// ps etime: [[dd-]hh:]mm:ss -> seconds.
const secs = (e) => { const [d, rest] = e.includes("-") ? e.split("-") : [0, e]; return rest.split(":").reduce((a, n) => a * 60 + Number(n), 0) + Number(d) * 86400; };
const hhmm = (time) => { const d = new Date(time); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const left = (endsAt) => { const m = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// [{pid, mode, endsAt}] for each counted caffeinate; endsAt is null when open-ended.
async function scan() {
  const r = await exec("/bin/ps", ["-axo", "pid=,etime=,command="], { timeout: 5000 });
  const out = [];
  for (const line of String(r.stdout ?? "").split("\n")) {
    const [pid, etime, cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd || cmd.split("/").pop() !== "caffeinate") continue;
    const ti = args.indexOf("-t"), t = ti >= 0 ? Number(args[ti + 1]) : 0;
    const flags = ti >= 0 ? args.filter((_, i) => i !== ti + 1) : args;
    if (!flags.every((a) => a.startsWith("-") && (a === "-t" || !/[tw]/.test(a)))) continue;
    if (ti >= 0 && !(t >= MIN_T)) continue;
    // Rounded to the minute so the shared state only changes when the shown time does.
    const endsAt = t ? Math.round((Date.now() - secs(etime) * 1000 + t * 1000) / 60000) * 60000 : null;
    out.push({ pid, mode: flags.some((a) => a.includes("d")) ? "display" : "system", endsAt });
  }
  return out;
}

export default class Caffeinate extends View {
  init(_props, cx) {
    if (!props()?.compact) {
      // Hours and minutes fields, kept in step with the chosen length; edits apply on Enter or leaving.
      this.h = InputState.new({ placeholder: "0" });
      this.m = InputState.new({ placeholder: "0" });
      this.typed = InputState.new({ placeholder: "ex: 1h30" });
      const fromFields = (cx) => this.pick(cx, (parseInt(this.h.value(), 10) || 0) * 60 + (parseInt(this.m.value(), 10) || 0));
      for (const f of [this.h, this.m]) { f.on("submit", (_e, cx) => fromFields(cx)); f.on("blur", (_e, cx) => fromFields(cx)); }
      this.typed.on("submit", (_e, cx) => {
        const min = parse(this.typed.value());
        this.bad = min === null;
        if (!this.bad) { this.typed.set_value(""); this.pick(cx, min); }
        cx.notify();
      });
      this.typed.on("change", (_e, cx) => { if (this.bad) { this.bad = false; cx.notify(); } });
      this.fill();
    }
    const panels = shared("workspace.panels");
    if (props()?.panel && Array.isArray(panels) && !panels.includes("caffeinate")) setShared("workspace.panels", [...panels, "caffeinate"]);
    this.refresh(cx);
    cx.timer.every(3000, (cx) => this.refresh(cx));
    // The time left counts down without the state changing.
    cx.timer.every(30000, (cx) => { if (this.active()?.endsAt) cx.notify(); });
  }

  refresh(cx) {
    cx.spawn(async () => {
      try {
        const procs = await scan();
        const prev = shared(KEY);
        if (JSON.stringify(prev?.procs) !== JSON.stringify(procs)) setShared(KEY, { procs, error: prev?.error });
      } catch {}
    });
  }

  // The active run: display wins when both run.
  active() {
    const procs = shared(KEY)?.procs ?? [];
    return procs.find((p) => p.mode === "display") ?? procs[0] ?? null;
  }

  mode() {
    const procs = shared(KEY)?.procs ?? [];
    return procs.some((p) => p.mode === "display") ? "display" : procs.length ? "system" : null;
  }

  mins() { return shared(MINS) ?? 0; }

  fill() {
    const min = this.mins();
    this.h?.set_value(String(Math.floor(min / 60)));
    this.m?.set_value(String(min % 60));
  }

  // A mode button: off when it's the active mode, else on (for the chosen length).
  toggle(cx, id) { this.start(cx, this.mode() === id ? null : id, this.mins()); }

  // A length (at least 10 minutes, or 0): remembered for the next start; restarts the running mode with it.
  pick(cx, min) {
    min = min > 0 ? Math.max(MIN_T / 60, Math.round(min)) : 0;
    const same = min === this.mins();
    setShared(MINS, min);
    this.fill();
    if (!same && this.mode()) this.start(cx, this.mode(), min);
  }

  start(cx, id, min) {
    cx.spawn(async () => {
      try {
        const pids = (shared(KEY)?.procs ?? []).map((p) => p.pid);
        if (pids.length) await exec("/bin/kill", pids);
        if (id) {
          const flag = MODES.find((m) => m.id === id).flag + (min ? ` -t ${min * 60}` : "");
          await exec("/bin/sh", ["-c", `nohup /usr/bin/caffeinate ${flag} >/dev/null 2>&1 &`], { timeout: 5000 });
        }
        setShared(KEY, { procs: await scan() });
      } catch (e) {
        setShared(KEY, { ...shared(KEY), error: String(e.message ?? e) });
      }
    });
  }

  togglePanel() {
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === "caffeinate")) return;
    if (!panel.hidden && body.active === "caffeinate") return run("layout.hide", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "caffeinate" });
    run("layout.show", { id: "panel" });
  }

  render(cx) {
    return props()?.compact ? this.renderChip(cx) : this.renderPanel();
  }

  renderChip(cx) {
    const t = theme(), mode = this.mode(), ends = this.active()?.endsAt;
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "caffeinate";
    const label = mode ? short[mode] + (ends ? ` · ${left(ends)}` : "") : "";
    // The block fits its content, like the Builds chip.
    const want = !mode ? 34 : (mode === "system" ? 82 : 64) + (ends ? 36 : 0);
    const node = find(layout(), "caffeinate-chip");
    if (node && node.size?.px !== want && this.want !== want) {
      this.want = want;
      cx.timer.after(1, () => run("layout.resize", { id: "caffeinate-chip", px: want }));
    }
    return h_flex().id("caffeinate-chip").size_full().items_center().justify_start().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("caffeinate-chip-btn").max_w_full().h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => this.togglePanel())
        .child(svg(ICON).size(14).text_color(mode ? t.working : on ? t.foreground : t.muted))
        .when(Boolean(mode), (el) => el.child(div().min_w(0).truncate().text_color(t.foreground).child(label))));
  }

  renderPanel() {
    const t = theme(), mode = this.mode(), ends = this.active()?.endsAt, min = this.mins();
    const close = h_flex().id("caffeinate-close").size(22).items_center().justify_center().rounded(5).text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click(() => run("layout.hide", { id: "panel" }))
      .child(svg("mods/pane/close.svg").size(12));
    const button = (m) => {
      const active = mode === m.id;
      return h_flex().id(`caffeinate-${m.id}`).px(12).py(10).gap(10).items_center().rounded(10).cursor_pointer()
        .bg(active ? t.raised : t.surface).border_1().border_color(active ? t.working : t.border)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(cx, m.id))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .child(div().font_semibold().child(m.label))
            .child(div().text_size(11).text_color(t.dim).child(`caffeinate ${m.flag}`)))
          .child(div().truncate().text_size(12).text_color(t.muted).child(m.hint)))
        .child(div().flex_none().px(8).py(2).rounded(10).bg(t.raised).text_size(11).font_semibold()
          .text_color(active ? t.working : t.dim).child(!active ? "Desligado" : ends ? `até ${hhmm(ends)}` : "Ligado"));
    };
    // Presets as one segmented control.
    const length = (h, i) => {
      const sel = h * 60 === min;
      return div().id(`caffeinate-h${h}`).flex_1().h_full().flex().items_center().justify_center().text_size(12).cursor_pointer()
        .when(i > 0, (el) => el.border_l(1).border_color(t.border))
        .bg(sel ? t.selected : t.background).text_color(sel ? t.foreground : t.muted)
        .when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.pick(cx, h * 60)).child(h ? `${h}h` : "Nunca");
    };
    const mono = settings().font_family ?? "JetBrains Mono";
    const input = (state) => Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground);
    const stepBtn = (id, label, fn) => h_flex().id(id).w(24).h_full().flex_none().items_center().justify_center()
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => fn(cx)).child(label);
    // Steppers, one pill each: hours by 1, minutes by 5 (carrying into hours).
    const stepper = (unit, by) => h_flex().id(`caffeinate-${unit}-pill`).h(28).flex_none().items_center().rounded(7).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border)
      .child(stepBtn(`caffeinate-${unit}-less`, "−", (cx) => this.pick(cx, Math.max(0, min - by))))
      .child(h_flex().id(`caffeinate-${unit}`).h_full().w(44).gap(3).px(4).items_center().border_l(1).border_r(1).border_color(t.border)
        .cursor_text().on_mouse_down("left", () => this[unit].focus())
        .child(div().w(18).font_family(mono).child(input(this[unit])))
        .child(div().text_size(11).text_color(t.dim).child(unit)))
      .child(stepBtn(`caffeinate-${unit}-more`, "+", (cx) => this.pick(cx, min + by)));
    const typed = h_flex().id("caffeinate-typed").flex_1().min_w(0).h(28).px(8).items_center().rounded(7)
      .bg(t.background).border_1().border_color(this.bad ? t.blocked : t.border).cursor_text()
      .on_mouse_down("left", () => this.typed.focus())
      .child(input(this.typed));
    const summary = !min ? "nunca" : `${Math.floor(min / 60) ? `${Math.floor(min / 60)}h` : ""}${min % 60 ? `${min % 60}min` : ""}`;
    const duration = v_flex().id("caffeinate-length").p(12).gap(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().items_center()
        .child(div().flex_1().font_semibold().child("Desligar depois de"))
        .child(div().text_size(12).text_color(min ? t.working : t.muted).child(summary)))
      .child(h_flex().id("caffeinate-presets").h(28).rounded(7).overflow_hidden().border_1().border_color(t.border)
        .children(HOURS.map(length)))
      .child(h_flex().gap(6).items_center().child(stepper("h", 60)).child(stepper("m", 5)).child(typed))
      .when(Boolean(this.bad), (el) => el.child(div().text_size(11).text_color(t.blocked).child("Não entendi. Use 1h30, 45m ou 2:15.")));
    return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_size(13).text_color(t.foreground)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Caffeinate"))
        .child(div().flex_1())
        .child(close))
      .child(v_flex().p(10).gap(10).children(MODES.map(button))
        .child(duration)
        .when(Boolean(shared(KEY)?.error), (el) => el.child(div().p(4).text_size(12).text_color(t.blocked).child(`Erro: ${shared(KEY)?.error}`))));
  }
}
