// EAS builds (and their store submissions) of the Expo project in the focused folder's repo.
// The project is the nearest eas.json above the folder, else one up to 4 levels inside the repo;
// its projectId comes from app.json or app.config.*. `eas build:list` / `eas submit:list` run in a
// small folder under .cache/ holding only that id, so the repo's node_modules aren't needed.
// The current step of a running build comes from its log (each line carries a "phase").
// props {compact: true}: tab bar chip, which polls (15s while something runs or waits, else 60s)
// and shares what it read. props {panel: true}: the side panel card, drawn from that.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, home, appHome, readTextFile, theme, props, layout, run, shared, setShared } from "herdr";
import * as fs from "fs/promises";

const KEY = "eas.state";
const ICON = "mods/eas-builds/box.svg";
const SPINNER = "mods/workspace-chrome/spinner.svg";
const ACTIVE = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"]);
const SUB_ACTIVE = new Set(["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS"]);
const LIMIT = 10;

const PHASES = {
  SPIN_UP_BUILDER: "Subindo a máquina", INSTALL_CUSTOM_TOOLS: "Ferramentas", PREPARE_PROJECT: "Preparar projeto",
  PRE_INSTALL_HOOK: "Hook pre-install", READ_EAS_JSON: "Ler eas.json", READ_PACKAGE_JSON: "Ler package.json",
  INSTALL_DEPENDENCIES: "Instalar dependências", READ_APP_CONFIG: "Ler app config", RUN_EXPO_DOCTOR: "Expo doctor",
  PREBUILD: "Prebuild", RESTORE_CACHE: "Restaurar cache", POST_INSTALL_HOOK: "Hook post-install",
  CALCULATE_EXPO_UPDATES_RUNTIME_VERSION: "Runtime version", PREPARE_CREDENTIALS: "Credenciais",
  CONFIGURE_ANDROID_VERSION: "Configurar versão", CONFIGURE_XCODE_PROJECT: "Configurar Xcode",
  CONFIGURE_EXPO_UPDATES: "Expo Updates", EAGER_BUNDLE: "Bundle JS", INSTALL_PODS: "Pod install",
  RUN_GRADLEW: "Gradle", RUN_FASTLANE: "Xcode (fastlane)", SAVE_CACHE: "Salvar cache",
  PRE_UPLOAD_ARTIFACTS_HOOK: "Hook pre-upload", UPLOAD_APPLICATION_ARCHIVE: "Upload do artefato",
  UPLOAD_BUILD_ARTIFACTS: "Upload de artefatos", ON_BUILD_SUCCESS_HOOK: "Hook de sucesso",
  ON_BUILD_COMPLETE_HOOK: "Hook final", COMPLETE_BUILD: "Finalizando",
};
const phaseName = (p) => PHASES[p] ?? p.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const dirname = (p) => p.slice(0, p.lastIndexOf("/")) || "/";
const ms = (iso) => (iso ? Date.parse(iso) : null);
const plat = (b) => (b.platform === "IOS" ? "iOS" : "Android");
const glyph = (b) => (b.platform === "IOS" ? "iOS" : "AND");
const store = (s) => (s.platform === "IOS" ? "App Store" : "Play Store");

function dur(n) {
  const s = Math.max(0, Math.floor(n / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ontem" : `há ${d} dias`;
}
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (space?.machine) return null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const r = find(c, id); if (r) return r; }
  return null;
}

const read = (p) => readTextFile(p).catch(() => null);

// The Expo project for a folder: { dir, id, slug } or null.
async function projectFor(cwd) {
  const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
  const top = g?.code === 0 ? g.stdout.trim() : cwd;
  let eas = null;
  for (let d = cwd; d.startsWith(top); d = dirname(d)) {
    if (await read(`${d}/eas.json`)) { eas = `${d}/eas.json`; break; }
    if (d === top) break;
  }
  if (!eas && g?.code === 0) {
    const f = await exec("find", [top, "-maxdepth", "4", "-name", "eas.json", "-not", "-path", "*/node_modules/*"], { cwd: top }).catch(() => null);
    eas = (f?.stdout ?? "").split("\n").filter(Boolean).sort((a, b) => a.length - b.length)[0] ?? null;
  }
  if (!eas) return null;
  const dir = dirname(eas);
  let id = null, slug = null;
  const aj = await read(`${dir}/app.json`);
  if (aj) {
    try { const e = JSON.parse(aj).expo ?? {}; id = e.extra?.eas?.projectId ?? null; slug = e.slug ?? null; } catch {}
  }
  for (const n of ["app.config.ts", "app.config.js", "app.config.mjs"]) {
    if (id) break;
    const src = await read(`${dir}/${n}`);
    if (!src) continue;
    id = /projectId\s*:\s*["']([0-9a-f-]{36})["']/.exec(src)?.[1] ?? null;
    slug = slug ?? /slug\s*:\s*["']([^"']+)["']/.exec(src)?.[1] ?? null;
  }
  // The id names a folder under .cache/: only a real project UUID.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) return null;
  return { dir, id, slug: slug ?? dir.split("/").pop() };
}

// A folder eas can run in for a project, holding only its id.
const prepared = new Set();
async function workDir(p) {
  const dir = `${appHome()}/mods/eas-builds/.cache/${p.id}`;
  if (prepared.has(dir)) return dir;
  await exec("mkdir", ["-p", dir]);
  await fs.writeFile(`${dir}/app.json`, JSON.stringify({ expo: { name: p.slug, slug: p.slug, extra: { eas: { projectId: p.id } } } }));
  await fs.writeFile(`${dir}/package.json`, JSON.stringify({ name: "eas-builds-probe", version: "1.0.0", private: true }));
  prepared.add(dir);
  return dir;
}

// eas on Herdr's PATH, else through mise (whose Node holds it when installed with npm -g).
let easCmd = null;
async function eas(args, cwd) {
  const argv = [...args, "--json", "--non-interactive"], opts = { cwd, timeout: 90000 };
  let r;
  if (easCmd !== "mise") r = await exec("eas", argv, opts).then((x) => { easCmd = "eas"; return x; }).catch(() => null);
  if (!r) { r = await exec(`${home()}/.local/bin/mise`, ["x", "--", "eas", ...argv], opts); easCmd = "mise"; }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n").pop() || `eas exited ${r.code}`);
  return JSON.parse(r.stdout);
}

async function nodeFetch(url) {
  const js = "fetch(process.argv[1]).then((r) => r.text()).then((t) => process.stdout.write(t))";
  const r = await exec(`${home()}/.local/bin/mise`, ["x", "--", "node", "-e", js, url], { timeout: 30000 }).catch(() => null);
  return r?.code === 0 ? r.stdout : "";
}

// Steps of a running build from its logs: [{ phase, at }] plus the last line's text.
async function steps(b) {
  const out = [];
  let last = "";
  for (const url of b.logFiles ?? []) {
    let text = await fetch(url).then((r) => r.text()).catch(() => "");
    // The logs are brotli-encoded; if this fetch hands back the raw bytes, Node decodes them.
    if (!text.trimStart().startsWith("{")) text = await nodeFetch(url);
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.phase && out[out.length - 1]?.phase !== j.phase) out.push({ phase: j.phase, at: ms(j.time) });
      if (j.msg) last = j.msg;
    }
  }
  return { steps: out, last };
}

export default class EasBuilds extends View {
  init(_props, cx) {
    this.busy = false; this.again = false; this.at = 0; this.projects = new Map();
    if (props()?.compact) {
      this.refresh(cx);
      cx.timer.every(5000, (cx) => {
        const st = shared(KEY);
        const live = st?.builds?.some((b) => ACTIVE.has(b.status)) || st?.subs?.some((s) => SUB_ACTIVE.has(s.status));
        if (Date.now() - this.at >= (live ? 15000 : 60000)) this.refresh(cx);
      });
    }
    // Clocks tick while something runs.
    cx.timer.every(1000, (cx) => { if (shared(KEY)?.builds?.some((b) => ACTIVE.has(b.status))) cx.notify(); });
  }

  refresh(cx) {
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.at = Date.now();
    cx.spawn(async (cx) => {
      const cwd = location();
      const next = { cwd, project: null, builds: [], subs: [], logs: {}, error: null, at: Date.now() };
      try {
        if (cwd) {
          if (!this.projects.has(cwd)) this.projects.set(cwd, await projectFor(cwd));
          next.project = this.projects.get(cwd);
        }
        if (next.project) {
          const dir = await workDir(next.project);
          const [builds, subs] = await Promise.all([
            eas(["build:list", "--limit", String(LIMIT)], dir),
            eas(["submit:list", "--limit", String(LIMIT)], dir).catch(() => []),
          ]);
          next.builds = builds; next.subs = subs;
          for (const b of builds.filter((b) => b.status === "IN_PROGRESS")) next.logs[b.id] = await steps(b);
        }
      } catch (e) {
        next.error = String(e.message ?? e);
        const prev = shared(KEY);
        if (prev?.project?.id === next.project?.id) Object.assign(next, { builds: prev.builds, subs: prev.subs, logs: prev.logs });
      }
      // Only the latest location's answer is kept.
      if (cwd === location()) setShared(KEY, next);
      this.busy = false;
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  togglePanel() {
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === "eas")) return;
    if (!panel.hidden && body.active === "eas") return run("layout.hide", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "eas" });
    run("layout.show", { id: "panel" });
  }

  render(cx) {
    if (props()?.compact) {
      // Another space or folder refreshes now, not on the next tick.
      const key = location() ?? "";
      if (key !== this.key) {
        if (this.key !== undefined) cx.timer.after(1, (cx) => this.refresh(cx));
        this.key = key;
      }
      return this.renderChip(cx);
    }
    return this.renderPanel();
  }

  renderChip(cx) {
    const t = theme(), st = shared(KEY);
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "eas";
    const running = st?.builds?.find((b) => b.status === "IN_PROGRESS");
    const queued = st?.builds?.filter((b) => b.status === "IN_QUEUE" || b.status === "NEW").length ?? 0;
    let label = "Builds";
    if (running) {
      const s = st.logs?.[running.id]?.steps ?? [];
      const cur = s[s.length - 1];
      label = `${dur(Date.now() - (s[0]?.at ?? ms(running.createdAt)))} · ${cur ? phaseName(cur.phase) : "rodando"}`;
    } else if (queued) label = `${queued} na fila`;
    // The block fits its label, so the Tasks chip sits as close as the tab bar's own buttons.
    const want = running ? 170 : queued ? 96 : 71;
    const node = find(layout(), "eas-chip");
    if (node && node.size?.px !== want && this.want !== want) {
      this.want = want;
      cx.timer.after(1, () => run("layout.resize", { id: "eas-chip", px: want }));
    }
    return h_flex().id("eas-chip").size_full().items_center().justify_start().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("eas-chip-btn").max_w_full().h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on || running ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => this.togglePanel())
        .child(running || queued ? svg(SPINNER).size(12).text_color(t.working).spin(900) : svg(ICON).size(14))
        .child(div().min_w(0).truncate().child(label)));
  }

  pill(t, text, kind) {
    const c = { run: t.working, ok: t.done, fail: t.blocked, wait: t.muted }[kind] ?? t.muted;
    return div().flex_none().px(8).py(2).rounded(10).bg(t.raised).text_size(11).font_semibold().text_color(c).child(text);
  }

  status(t, b) {
    const total = ms(b.completedAt) && ms(b.createdAt) ? dur(ms(b.completedAt) - ms(b.createdAt)) : "";
    switch (b.status) {
      case "FINISHED": return this.pill(t, `Pronto · ${total}`, "ok");
      case "ERRORED": return this.pill(t, `Falhou · ${total}`, "fail");
      case "CANCELED": return this.pill(t, "Cancelado", "wait");
      case "PENDING_CANCEL": return this.pill(t, "Cancelando", "wait");
      case "IN_PROGRESS": return this.pill(t, "Rodando", "run");
      default: return this.pill(t, `Na fila · ${dur(Date.now() - ms(b.createdAt))}`, "wait");
    }
  }

  subLine(t, s, orphan = false) {
    const start = ms(s.createdAt), end = ms(s.completedAt);
    const [text, color] = {
      FINISHED: [`enviado em ${end ? dur(end - start) : ""}`, t.done],
      ERRORED: ["falhou", t.blocked],
      CANCELED: ["cancelado", t.muted],
      IN_PROGRESS: [`enviando · ${dur(Date.now() - start)}`, t.working],
      IN_QUEUE: ["na fila", t.muted],
      AWAITING_BUILD: ["aguardando o build", t.muted],
    }[s.status] ?? [s.status.toLowerCase(), t.muted];
    return h_flex().gap(6).items_center().text_size(11)
      .child(svg("mods/tasks/done.svg").size(11).text_color(color))
      .child(div().text_color(t.muted).child(store(s)))
      .child(div().text_color(color).child(text))
      .child(div().flex_1())
      .when(Boolean(end) && orphan, (el) => el.child(div().text_color(t.dim).child(ago(end))));
  }

  link(t, id, label, url) {
    return div().id(id).text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click(() => exec("open", [url]).catch(() => {})).child(label);
  }

  glyphBox(t, b) {
    return div().flex_none().size(32).rounded(8).bg(t.raised).flex().items_center().justify_center()
      .text_size(11).font_semibold().text_color(b.platform === "IOS" ? t.foreground : t.done).child(glyph(b));
  }

  expoUrl(b, st) {
    const owner = b.app?.ownerAccount?.name, slug = b.app?.slug ?? st.project.slug;
    return `https://expo.dev/accounts/${owner}/projects/${slug}/builds/${b.id}`;
  }

  runningCard(t, b, st, subs) {
    const log = st.logs?.[b.id] ?? { steps: [], last: "" };
    const s = log.steps, now = Date.now();
    const start = s[0]?.at ?? ms(b.createdAt);
    const shown = s.slice(-4).map((x, i, a) => {
      const k = s.length - a.length + i, cur = k === s.length - 1;
      const end = cur ? now : s[k + 1].at;
      return h_flex().gap(8).items_center().text_size(12)
        .child(div().flex_none().w(14).child(cur ? svg(SPINNER).size(12).text_color(t.working).spin(900)
          : svg("mods/tasks/done.svg").size(12).text_color(t.done)))
        .child(div().flex_1().min_w(0).truncate().text_color(cur ? t.foreground : t.muted).child(phaseName(x.phase)))
        .child(div().text_color(t.dim).child(dur(end - x.at)));
    });
    return v_flex().id(`b-${b.id}`).p(12).gap(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(this.glyphBox(t, b))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().font_semibold().child(`${plat(b)} ${b.appVersion ?? ""} (${b.appBuildVersion ?? "?"})`))
          .child(div().truncate().text_size(12).text_color(t.muted)
            .child(`${b.buildProfile} · por ${b.initiatingActor?.displayName ?? "?"} · ${(b.gitCommitHash ?? "").slice(0, 7)}`)))
        .child(this.status(t, b)))
      .when(Boolean(b.gitCommitMessage), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(b.gitCommitMessage.split("\n")[0])))
      .child(v_flex().gap(6).px(10).py(8).rounded(8).bg(t.background)
        .when(!s.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Lendo o log…")))
        .children(shown)
        .when(Boolean(log.last), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(log.last))))
      .child(h_flex().gap(12).items_center().text_size(12)
        .child(div().text_color(t.working).child(dur(now - start)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`início ${hhmm(start)} · etapa ${s.length || "?"}`))
        .when(Boolean(b.logFiles?.length), (el) => el.child(this.link(t, `log-${b.id}`, "Logs", b.logFiles[b.logFiles.length - 1])))
        .child(this.link(t, `expo-${b.id}`, "Expo", this.expoUrl(b, st))))
      .children(subs.map((x) => this.subLine(t, x)));
  }

  smallCard(t, b, st, subs) {
    const sub = b.status === "ERRORED" && b.error?.message ? b.error.message : (b.gitCommitMessage ?? "").split("\n")[0];
    const when = ms(b.completedAt) ?? ms(b.createdAt);
    return v_flex().id(`b-${b.id}`).p(12).gap(8).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .hover((s) => s.bg(t.hover)).on_click(() => exec("open", [this.expoUrl(b, st)]).catch(() => {}))
      .child(h_flex().gap(10).items_center()
        .child(this.glyphBox(t, b))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().font_semibold().child(`${plat(b)} ${b.appVersion ?? ""} (${b.appBuildVersion ?? "?"})`))
          .child(div().truncate().text_size(12).text_color(b.status === "ERRORED" ? t.blocked : t.muted).child(`${b.buildProfile} · ${sub}`)))
        .child(v_flex().flex_none().items_end().gap(2)
          .child(this.status(t, b))
          .when(!ACTIVE.has(b.status), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(when))))))
      .children(subs.map((x) => this.subLine(t, x)));
  }

  orphanCard(t, s) {
    return v_flex().id(`s-${s.id}`).px(12).py(10).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().pb(4).text_size(12).font_semibold().child(`Envio para a ${store(s)}`))
      .child(this.subLine(t, s, true));
  }

  renderPanel() {
    const t = theme(), st = shared(KEY);
    const close = h_flex().id("eas-close").size(22).items_center().justify_center().rounded(5).text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click(() => run("layout.hide", { id: "panel" }))
      .child(svg("mods/pane/close.svg").size(12));
    const builds = [...(st?.builds ?? [])].sort((a, b) =>
      (ACTIVE.has(b.status) ? 1 : 0) - (ACTIVE.has(a.status) ? 1 : 0)
      || (b.status === "IN_PROGRESS" ? 1 : 0) - (a.status === "IN_PROGRESS" ? 1 : 0)
      || ms(b.createdAt) - ms(a.createdAt));
    const ids = new Set(builds.map((b) => b.id));
    const subsOf = (b) => (st?.subs ?? []).filter((s) => s.submittedBuild?.id === b.id);
    const orphans = (st?.subs ?? []).filter((s) => !ids.has(s.submittedBuild?.id) && SUB_ACTIVE.has(s.status));
    const note = !st ? "Carregando…"
      : !st.cwd ? "Nenhuma pasta neste space"
      : !st.project ? "Nenhum projeto EAS neste repositório"
      : st.error && !builds.length ? `Erro: ${st.error}`
      : !builds.length ? "Nenhum build ainda" : null;
    return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_size(13).text_color(t.foreground)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Builds"))
        .when(Boolean(st?.project), (el) => el.child(div().text_size(12).text_color(t.muted).child(st.project.slug)))
        .child(div().flex_1())
        .when(Boolean(st?.at), (el) => el.child(div().text_size(11).text_color(st.error ? t.blocked : t.dim)
          .child(st.error ? "erro ao atualizar" : `atualizado ${ago(st.at)}`)))
        .child(close))
      .child(v_flex().id("eas-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(10)
        .when(Boolean(note), (el) => el.child(div().p(4).text_size(12).text_color(t.dim).child(note)))
        .children(orphans.map((s) => this.orphanCard(t, s)))
        .children(builds.map((b) => b.status === "IN_PROGRESS" ? this.runningCard(t, b, st, subsOf(b)) : this.smallCard(t, b, st, subsOf(b)))));
  }
}
