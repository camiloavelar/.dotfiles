// Shows and toggles `caffeinate` (keeps the Mac awake).
// Only open-ended runs count (flags only, no -t or -w and no command), so the short
// `caffeinate -i -t 300` other apps start don't show. Any -d in the flags means the display stays on.
// props {compact: true}: tab bar chip. props {panel: true}: side panel with one toggle per mode.
// "Off" kills the open-ended caffeinate processes; "on" starts one detached, so it outlives Herdr.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, layout, run, shared, setShared } from "herdr";

const KEY = "caffeinate.state";
const ICON = "mods/caffeinate/cup.svg";
const MODES = [
  { id: "system", flag: "-i", label: "Sistema acordado", hint: "Impede o Mac de dormir; a tela pode apagar" },
  { id: "display", flag: "-d", label: "Tela acordada", hint: "Mantém a tela ligada (e o Mac acordado)" },
];
const short = { system: "Sistema", display: "Tela" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// [{pid, mode}] for each open-ended caffeinate.
async function scan() {
  const r = await exec("/bin/ps", ["-axo", "pid=,command="], { timeout: 5000 });
  const out = [];
  for (const line of String(r.stdout ?? "").split("\n")) {
    const [pid, cmd, ...args] = line.trim().split(/\s+/);
    if (!cmd || cmd.split("/").pop() !== "caffeinate") continue;
    if (!args.every((a) => a.startsWith("-") && !/[tw]/.test(a))) continue;
    out.push({ pid, mode: args.some((a) => a.includes("d")) ? "display" : "system" });
  }
  return out;
}

export default class Caffeinate extends View {
  init(_props, cx) {
    const panels = shared("workspace.panels");
    if (props()?.panel && Array.isArray(panels) && !panels.includes("caffeinate")) setShared("workspace.panels", [...panels, "caffeinate"]);
    this.refresh(cx);
    cx.timer.every(3000, (cx) => this.refresh(cx));
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

  // The active mode: display wins when both run.
  mode() {
    const procs = shared(KEY)?.procs ?? [];
    return procs.some((p) => p.mode === "display") ? "display" : procs.length ? "system" : null;
  }

  toggle(cx, id) {
    const active = this.mode();
    cx.spawn(async () => {
      try {
        const pids = (shared(KEY)?.procs ?? []).map((p) => p.pid);
        if (pids.length) await exec("/bin/kill", pids);
        if (active !== id) {
          const flag = MODES.find((m) => m.id === id).flag;
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
    const t = theme(), mode = this.mode();
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "caffeinate";
    // The block fits its content, like the Builds chip.
    const want = mode === "system" ? 82 : mode === "display" ? 64 : 34;
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
        .when(Boolean(mode), (el) => el.child(div().min_w(0).truncate().text_color(t.foreground).child(short[mode]))));
  }

  renderPanel() {
    const t = theme(), mode = this.mode();
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
          .text_color(active ? t.working : t.dim).child(active ? "Ligado" : "Desligado"));
    };
    return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_size(13).text_color(t.foreground)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Caffeinate"))
        .child(div().flex_1())
        .child(close))
      .child(v_flex().p(10).gap(10).children(MODES.map(button))
        .when(Boolean(shared(KEY)?.error), (el) => el.child(div().p(4).text_size(12).text_color(t.blocked).child(`Erro: ${shared(KEY)?.error}`))));
  }
}
