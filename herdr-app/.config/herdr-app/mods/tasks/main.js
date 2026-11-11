// Superpowers plan progress for the focused folder's repo.
// Tasks come from the plan (docs/superpowers/plans/*.md, "### Task N: name", "- [ ]" steps);
// done marks come from the SDD ledger (.superpowers/sdd/<plan>/progress.md, "Task N: complete ...",
// or the older "- [x] Task N: ..." checklist). The plan is the one the followed Claude session
// touched (found in its log); without one, the repo's latest plan shows as a collapsed line. Polls every 3s.
// Above the plan: what the focused Claude agent is doing, from its session log
// (terminal -> `hc get` pid -> ~/.claude/sessions/<pid>.json -> ~/.claude/projects/<slug>/<id>.jsonl).
// props {panel: true}: side panel card. props {compact: true}: tab bar chip that opens the panel.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, agents, exec, home, readTextFile, watchFolder, theme, props, layout, run, shared, setShared } from "herdr";

const POLL_MS = 3000;
const ICON = (n) => `mods/tasks/${n}.svg`;
const SPINNER = "mods/workspace-chrome/spinner.svg";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (space?.machine) return null; // files on another machine: not supported
  return pane?.cwd || f?.cwd || space?.folder || null;
}

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const r = find(c, id); if (r) return r; }
  return null;
}

const dirname = (p) => p.slice(0, p.lastIndexOf("/"));
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
const TASK_HEAD = /^#{2,4}\s+Task\s+(\d+)\s*[:.\u2013\u2014-]?\s*(.*)$/i;

function parsePlan(text) {
  const tasks = [];
  let title = null, cur = null, fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; if (cur) cur.body.push(line); continue; }
    if (fenced) { if (cur) cur.body.push(line); continue; }
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && !title) title = h1[1].trim();
    const m = TASK_HEAD.exec(line);
    if (m) { cur = { n: +m[1], name: m[2].trim() || `Task ${m[1]}`, steps: 0, checked: 0, body: [] }; tasks.push(cur); continue; }
    if (/^#{1,2}\s/.test(line)) cur = null; // a new top section ends the task
    if (cur) cur.body.push(line);
    const s = /^\s*[-*]\s+\[([ xX])\]/.exec(line);
    if (s && cur) { cur.steps++; if (s[1] !== " ") cur.checked++; }
  }
  for (const t of tasks) t.body = t.body.join("\n").trim();
  return { title, tasks };
}

// "4", "4+5", "3 e 4", "3 and 4", "1-3", "1, 2" -> [numbers]
function taskIds(spec) {
  const out = [];
  for (const part of spec.split(/\s*(?:\+|,|&|\be\b|\band\b)\s*/i)) {
    const r = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (r) for (let i = +r[1]; i <= +r[2] && i - +r[1] < 50; i++) out.push(i);
    else if (/^\d+$/.test(part.trim())) out.push(+part.trim());
  }
  return out;
}

function parseLedger(text) {
  const done = new Set(), started = new Set(), legacy = [], lines = {};
  let plan = null;
  for (const line of text.split("\n")) {
    const p = /plan:\s*(\S.*)$/i.exec(line);
    if (p && !plan) plan = p[1].trim();
    let m = /^\s*Tasks?\s+(\d+(?:\s*(?:\+|,|&|-|\be\b|\band\b)\s*\d+)*)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const ids = taskIds(m[1]), isDone = /^complete\b/i.test(m[2]);
      for (const n of ids) {
        started.add(n);
        if (isDone) { done.add(n); lines[n] = line.trim(); }
      }
    }
    m = /^\s*[-*]\s+\[([ xX])\]\s*Task\s+(\d+)\s*[:.\u2013\u2014-]?\s*(.*)$/i.exec(line);
    if (m) {
      const ok = m[1] !== " ";
      legacy.push({ n: +m[2], name: m[3].replace(/\s+[\u2013\u2014-]\s+commit\b.*$/i, "").trim(), steps: 0, checked: 0 });
      if (ok) done.add(+m[2]);
      lines[+m[2]] = line.trim();
    }
  }
  return { done, started, legacy, plan, lines };
}

// Each task's state: done (ledger "complete", or every step ticked), working, or pending.
// Working: a task the ledger mentions but hasn't completed; else `active`, the task the session
// last dispatched an agent for ("Implement Task 2", "Review Task 2"), until the ledger completes
// it (SDD writes a task's first ledger line only after it is implemented); else, for inline runs
// ticking the plan, the first open task with a checked step.
function assignStates(tasks, done, started, active) {
  const anyStarted = tasks.some((x) => started.has(x.n) && !done.has(x.n));
  const activeOpen = active != null && !done.has(active) && tasks.some((x) => x.n === active);
  let current = false;
  for (const task of tasks) {
    const finished = done.has(task.n) || (task.steps > 0 && task.checked === task.steps);
    if (finished) task.state = "done";
    else if (anyStarted ? started.has(task.n) : activeOpen ? task.n === active : !current && !started.size && task.checked > 0) { task.state = "working"; current = true; }
    else task.state = "pending";
  }
}

// A plan or SDD workspace under root, as { title, file, tasks: [{n, name, steps, checked, state}] }:
// `want` ({plan} or {dir}) when given, else the newest one. `active`: see assignStates.
async function load(root, want = null, active = null) {
  const sdd = `${root}/.superpowers/sdd`, plans = `${root}/docs/superpowers/plans`;
  const r = await exec("find", [sdd, plans, "-maxdepth", "2", "(", "-name", "*.md", "-o", "-name", "plan-path", ")",
    "-exec", "stat", "-f", "%m %N", "{}", "+"], { timeout: 5000 }).catch(() => null);
  const files = (r?.stdout ?? "").split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return { t: +l.slice(0, i), path: l.slice(i + 1) };
  });

  // SDD workspaces: each folder under sdd (or sdd itself, the old layout) with a ledger or marker.
  const spaces = new Map();
  for (const f of files.filter((f) => f.path.startsWith(`${sdd}/`))) {
    const dir = dirname(f.path);
    const w = spaces.get(dir) ?? { dir, t: 0, ledger: null, marker: null };
    w.t = Math.max(w.t, f.t);
    if (basename(f.path) === "progress.md") w.ledger = f.path;
    if (basename(f.path) === "plan-path") w.marker = f.path;
    spaces.set(dir, w);
  }
  const resolve = (p) => (p.startsWith("/") ? p : `${root}/${p}`);
  const candidates = [];
  for (const w of spaces.values()) {
    if (!w.ledger && !w.marker) continue;
    const ledgerText = w.ledger ? (await readTextFile(w.ledger)) ?? "" : "";
    const ledger = parseLedger(ledgerText);
    const marker = w.marker ? ((await readTextFile(w.marker)) ?? "").trim() : "";
    const planRef = marker || ledger.plan;
    candidates.push({ t: w.t, plan: planRef ? resolve(planRef) : null, ledger, dir: w.dir });
  }
  const claimed = new Set(candidates.map((c) => c.plan));
  for (const f of files.filter((f) => f.path.startsWith(`${plans}/`) && f.path.endsWith(".md"))) {
    if (!claimed.has(f.path)) candidates.push({ t: f.t, plan: f.path, ledger: null });
  }
  let pick;
  if (want) {
    pick = candidates.find((c) => (want.dir && c.dir === want.dir) || (want.plan && c.plan === want.plan && c.ledger))
      ?? candidates.find((c) => want.plan && c.plan === want.plan)
      ?? (want.plan ? { t: 0, plan: want.plan, ledger: null } : null);
    if (!pick) return null;
  } else {
    if (!candidates.length) return null;
    pick = candidates.sort((a, b) => b.t - a.t)[0];
  }

  const planText = pick.plan ? await readTextFile(pick.plan).catch(() => null) : null;
  if (want?.plan && !planText && !pick.ledger) return null; // a plan the session named that's gone
  const plan = planText ? parsePlan(planText) : { title: null, tasks: [] };
  const done = pick.ledger?.done ?? new Set();
  const tasks = plan.tasks.length ? plan.tasks : pick.ledger?.legacy ?? [];
  const started = pick.ledger?.started ?? new Set();
  const paths = new Set(files.map((f) => f.path));
  for (const task of tasks) {
    task.ledgerLine = pick.ledger?.lines?.[task.n] ?? null;
    const report = pick.dir ? `${pick.dir}/task-${task.n}-report.md` : null;
    task.report = report && paths.has(report) ? report : null;
  }
  assignStates(tasks, done, started, active);
  const title = (plan.title || (pick.plan ? basename(pick.plan).replace(/\.md$/, "") : "Plan"))
    .replace(/\s+Implementation Plan$/i, "");
  return { title, file: pick.plan, started: Boolean(pick.ledger), tasks };
}

const STEPS = 8; // activity rows shown
const plain = (l) => l.replace(/\*\*|__|`/g, "").replace(/^#+\s+/, "").replace(/^[-*]\s+/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const oneLine = (text, max = 160) => {
  const l = plain(String(text ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? "");
  return l.length > max ? `${l.slice(0, max - 1)}\u2026` : l;
};

// A tool call as Claude Code shows it: the Bash description, else tool + target.
function describe(x) {
  const i = x.input ?? {}, file = (p) => (p ? basename(String(p)) : "");
  switch (x.name) {
    case "Bash": return i.description || `$ ${oneLine(i.command)}`;
    case "Read": return `Read ${file(i.file_path)}`;
    case "Edit": case "MultiEdit": return `Edit ${file(i.file_path)}`;
    case "Write": return `Write ${file(i.file_path)}`;
    case "NotebookEdit": return `Edit ${file(i.notebook_path)}`;
    case "Grep": return `Search "${oneLine(i.pattern, 60)}"`;
    case "Glob": return `Find ${i.pattern}`;
    case "Agent": case "Task": return `Agent: ${i.description ?? i.subagent_type ?? ""}`;
    case "Skill": return `Skill ${i.skill}`;
    case "WebFetch": return `Fetch ${i.url}`;
    case "WebSearch": return `Web search "${oneLine(i.query, 60)}"`;
    case "AskUserQuestion": return "Asking you a question";
    case "ToolSearch": return "Loading tools";
    default: return x.name.includes("__") ? x.name.split("__").pop().replace(/_/g, " ") : x.name;
  }
}

// The plan task an Agent/Task dispatch is for ("Implement Task 2: the rule"), or null.
function taskOf(x) {
  if (x.name !== "Agent" && x.name !== "Task") return null;
  const m = /\bTask\s+(\d+)\b/i.exec(String(x.input?.description ?? ""));
  return m ? +m[1] : null;
}

const MAX_DETAIL = 4000;
const clip = (text, max = MAX_DETAIL) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n\u2026 (${s.length - max} more chars)` : s;
};
// A fenced block that survives backticks inside the text.
const fence = (text, lang = "") => `\`\`\`\`${lang}\n${clip(text).replace(/\`\`\`\`/g, "\`\`\` \`")}\n\`\`\`\``;

// What a step did, in full: the command, the edit, the prompt.
function inputDetail(x) {
  const i = x.input ?? {};
  switch (x.name) {
    case "Bash": return fence(i.command, "sh");
    case "Read": return `\`${i.file_path}\`${i.offset ? ` from line ${i.offset}` : ""}`;
    case "Edit": return `\`${i.file_path}\`\n\n${fence([...String(i.old_string ?? "").split("\n").map((l) => `- ${l}`), ...String(i.new_string ?? "").split("\n").map((l) => `+ ${l}`)].join("\n"), "diff")}`;
    case "Write": return `\`${i.file_path}\`\n\n${fence(i.content)}`;
    case "Grep": return `\`${i.pattern}\`${i.path ? ` in \`${i.path}\`` : ""}`;
    case "Glob": return `\`${i.pattern}\`${i.path ? ` in \`${i.path}\`` : ""}`;
    case "Agent": case "Task": return clip(i.prompt ?? "");
    default: return fence(JSON.stringify(i, null, 2), "json");
  }
}
const resultText = (r) => (typeof r.content === "string" ? r.content
  : Array.isArray(r.content) ? r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");

const KEEP = 40;               // steps kept per session (STEPS shown)
const TAIL_BYTES = 512 * 1024; // how far back the first read of a log starts

// UTF-8 length of a string, to advance a byte offset by what was read.
function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const userText = (d) => {
  if (d.isMeta || d.isCompactSummary) return null;
  const c = d.message?.content;
  const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
  return t && !t.startsWith("<") ? t : null;
};

// One log record into a session's steps and prompt (sub-agents left out).
function consume(st, d) {
  if (d.type === "queue-operation" && d.operation === "enqueue" && d.content) { st.prompt = oneLine(d.content); return; }
  if (d.isSidechain || !d.message) return;
  const c = d.message.content;
  if (d.type === "user") {
    const t = userText(d);
    if (t) st.prompt = oneLine(t);
    if (Array.isArray(c)) for (const x of c) {
      if (x.type !== "tool_result") continue;
      const s = st.open.get(x.tool_use_id);
      if (s) { s.running = false; s.error = Boolean(x.is_error); s.output = resultText(x); st.open.delete(x.tool_use_id); }
    }
    return;
  }
  if (d.type !== "assistant" || !Array.isArray(c)) return;
  for (const x of c) {
    if (x.type === "text" && x.text?.trim()) st.steps.push({ kind: "text", key: `${d.uuid}-${st.steps.length}`, text: oneLine(x.text), full: x.text });
    if (x.type === "tool_use") {
      const n = taskOf(x);
      if (n != null) st.lastTask = n;
      const s = { kind: "tool", key: x.id, text: describe(x), detail: inputDetail(x), running: true, error: false, output: null };
      st.steps.push(s); st.open.set(x.id, s);
    }
  }
  if (st.steps.length > KEEP) {
    for (const s of st.steps.splice(0, st.steps.length - KEEP)) if (s.kind === "tool") st.open.delete(s.key);
  }
}

// Plan and SDD workspace paths in text: absolute, ~/, or relative to the repo.
const PLAN_RE = /((?:~|\/)[^\s"'`\\]*?)?(docs\/superpowers\/plans\/[\w.@+-]+\.md|\.superpowers\/sdd(?:\/[\w.@+-]+)?)/g;
const repoOf = (p) => {
  const i = p.indexOf("/docs/superpowers/plans/"), j = p.indexOf("/.superpowers/sdd");
  return i >= 0 ? p.slice(0, i) : j >= 0 ? p.slice(0, j) : null;
};

// Plan and workspace paths one log record names, into `found` (path -> {score, seq}), scored by
// how strongly the session owns them: 3 it wrote the ledger or ran the plan (task-done,
// sdd-workspace, an implementer's workspace), 2 it wrote the plan or handed it to an agent or
// skill, 1 it read or mentioned it. Returns whether anything was added.
function mention(found, d, base, seq) {
  let added = false;
  const add = (text, score) => {
    for (const m of String(text ?? "").matchAll(PLAN_RE)) {
      let pre = m[1] ?? "", rest = m[2];
      if (pre.startsWith("~")) pre = home() + pre.slice(1);
      let path = pre ? `${pre.replace(/\/$/, "")}/${rest}` : `${base}/${rest}`;
      if (!path.startsWith("/")) continue;
      // An old-layout file right under sdd/ (progress.md, task-1-brief.md) is that workspace.
      const sdd = /^(.*\/\.superpowers\/sdd)(\/[^/]+)?$/.exec(path);
      if (sdd && (!sdd[2] || /\.(md|diff)$|^\/(plan-path|\.gitignore)$/.test(sdd[2]))) path = sdd[1];
      const prev = found.get(path);
      found.set(path, { score: Math.max(prev?.score ?? 0, score), seq });
      added = true;
    }
  };
  const c = d.message?.content;
  if (d.type === "user") { add(userText(d), 1); return added; }
  if (d.type !== "assistant" || !Array.isArray(c)) return added;
  for (const x of c) {
    if (x.type !== "tool_use") continue;
    const i = x.input ?? {};
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(x.name)) {
      const f = String(i.file_path ?? i.notebook_path ?? "");
      add(f, f.includes("/.superpowers/sdd") ? 3 : 2);
    } else if (x.name === "Bash") {
      const cmd = String(i.command ?? "");
      add(cmd, 1);
      // Running superpowers' scripts on a plan, or appending to a ledger.
      for (const m of cmd.matchAll(/(?:^|[\s;&|(\/])(?:sdd-workspace|task-done|task-start|task-brief|review-package)\s+["']?([^\s"';&|)]+)/g)) add(m[1], 3);
      for (const m of cmd.matchAll(/(?:>>|\btee\s+-a)\s*["']?([^\s"';&|)]*\.superpowers\/sdd\/[^\s"';&|)]*)/g)) add(m[1], 3);
    } else if (x.name === "Agent" || x.name === "Task" || x.name === "Skill") {
      const text = JSON.stringify(i);
      add(text, 2);
      if (/\.superpowers\/sdd/.test(text)) add(text.match(/[^\s"']*\.superpowers\/sdd\/[\w.@+-]+/g)?.join(" "), 3);
    } else add(JSON.stringify(i), 1);
  }
  return added;
}

// The Claude agent to follow: the focused terminal if it's one, else the first in the focused tab.
function followed() {
  const f = focused(), list = agents();
  return list.find((a) => a.address === f?.terminal || a.address === f?.agent)
    ?? list.find((a) => a.tab === f?.tab) ?? null;
}

async function sessionLog(address) {
  const g = await exec("hc", ["get", address, "--json"], { timeout: 5000 }).catch(() => null);
  if (g?.code !== 0) return null;
  const pid = JSON.parse(g.stdout)?.foreground?.pid;
  if (!pid) return null;
  const s = await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null);
  if (!s) return null;
  const { sessionId, cwd } = JSON.parse(s);
  if (!sessionId) return null;
  const guess = `${home()}/.claude/projects/${String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}.jsonl`;
  return { pid, sessionId, cwd, guess };
}

export default class Tasks extends View {
  init(_props, cx) {
    this.root = null; this.data = null; this.repoPlan = null; this.note = "Loading…";
    this.agent = null; this.act = null; this.session = null;
    this.busy = false; this.again = false; this.sig = null; this.watched = null;
    this.roots = new Map();     // cwd -> repo root ("" when not a repo)
    this.logs = new Map();      // terminal address -> { at, s } (hc get + sessions file, 10s)
    this.sessions = new Map();  // sessionId -> incremental log state
    this.expanded = new Set(); this.reports = new Map(); // report path -> text
    this.showRepo = false;
    // The tab bar remembers each space's open panel, but only panels listed here.
    const panels = shared("workspace.panels");
    if (props()?.panel && Array.isArray(panels) && !panels.includes("tasks")) setShared("workspace.panels", [...panels, "tasks"]);
    this.refresh(cx);
    cx.timer.every(POLL_MS, (cx) => this.refresh(cx));
  }

  // Coalesced: a refresh asked for while one runs runs once more after it.
  refresh(cx) {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      const panel = Boolean(props()?.panel);
      // Everything is computed first and swapped in at once, so a redraw never sees half a state.
      const next = { agent: null, session: null, act: null, data: null, repoPlan: null, note: null, root: null };
      try {
        await this.follow(next, panel);
        const st = next.session && this.sessions.get(next.session.sessionId);
        // The plan this session touched, wherever its repo is.
        const want = st ? await this.sessionPlan(st) : null;
        next.data = want ? await load(repoOf(want.plan ?? want.dir), want, st.lastTask) : null;
        const cwd = location();
        next.root = cwd ? await this.repoRoot(cwd) : null;
        if (panel && !next.data) {
          // Fallback: the repo's newest plan, shown collapsed.
          if (!cwd) next.note = "No folder for this space";
          else if (!next.root) next.note = "Not in a git repository";
          else {
            next.repoPlan = await load(next.root);
            if (!next.repoPlan) next.note = "No superpowers plan in this repo";
          }
        }
      } catch (e) {
        next.note = `Couldn't read the plan: ${e}`;
      }
      Object.assign(this, next);
      if (next.session) this.watch(dirname(next.session.path), cx);
      const sig = this.signature();
      if (sig !== this.sig) { this.sig = sig; cx.notify(); }
      this.busy = false;
      // The chip copy, always on screen, keeps every agent's progress for the agents list.
      if (!panel) await this.progressAll().catch(() => {});
      if (this.again) { this.again = false; this.refresh(cx); }
    });
  }

  // What the panel shows, as text: redraw only when it changes.
  signature() {
    const plan = (d) => d && [d.file, d.title, d.started, d.tasks.map((x) => `${x.n}${x.state}${x.checked}`).join(",")];
    return JSON.stringify([
      this.agent && [this.agent.address, this.agent.status, this.agent.title, this.agent.app],
      this.act && [this.act.prompt, this.act.spinner, this.act.steps.map((x) => [x.key, x.text, x.running, x.error, x.output?.length])],
      plan(this.data), plan(this.repoPlan), this.note, this.root,
    ]);
  }

  // Redraw soon after the agent writes its log, not only on the timer.
  watch(dir, cx) {
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { if (this.watched === dir) this.watched = null; }
    });
  }

  async repoRoot(cwd) {
    if (!this.roots.has(cwd)) {
      const g = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 }).catch(() => null);
      this.roots.set(cwd, g?.code === 0 ? g.stdout.trim() : "");
    }
    return this.roots.get(cwd) || null;
  }

  // A Claude agent's session log state, read up to now (null when it can't be found).
  async sessionOf(a) {
    let hit = this.logs.get(a.address);
    if (!hit || Date.now() - hit.at > 10000) {
      hit = { at: Date.now(), s: await sessionLog(a.address).catch(() => null) };
      this.logs.set(a.address, hit);
    }
    const s = hit.s;
    if (!s) return null;
    let st = this.sessions.get(s.sessionId);
    if (!st) {
      let path = s.guess;
      if ((await exec("test", ["-f", path]).catch(() => null))?.code !== 0) {
        const f = await exec("find", [`${home()}/.claude/projects`, "-maxdepth", "2", "-name", `${s.sessionId}.jsonl`], { timeout: 5000 }).catch(() => null);
        path = f?.stdout?.split("\n")[0];
      }
      if (!path) return null;
      const base = (s.cwd && (await this.repoRoot(s.cwd))) || s.cwd || home();
      st = { sessionId: s.sessionId, path, base, offset: null, steps: [], open: new Map(), prompt: null,
        found: new Map(), seq: 0, planDirty: true, want: null, lastTask: null };
      this.sessions.set(s.sessionId, st);
    }
    await this.readNew(st);
    return st;
  }

  // Every Claude agent running a superpowers plan, as shared "tasks.progress":
  // { <address>: { done, total, working } }, for the agents list's X/Y labels.
  async progressAll() {
    const out = {};
    for (const a of agents()) {
      if (a.app !== "claude-code") continue;
      try {
        const st = await this.sessionOf(a);
        const want = st && (await this.sessionPlan(st));
        const d = want && (await load(repoOf(want.plan ?? want.dir), want, st.lastTask));
        if (!d?.tasks?.length) continue;
        out[a.address] = { done: d.tasks.filter((x) => x.state === "done").length, total: d.tasks.length,
          working: d.tasks.some((x) => x.state === "working") };
      } catch {}
    }
    // setShared redraws every mod: publish only a change.
    if (JSON.stringify(out) !== JSON.stringify(shared("tasks.progress") ?? {})) setShared("tasks.progress", out);
  }

  // The followed agent, its session and (with `withActivity`) its last steps, into `next`.
  async follow(next, withActivity) {
    const a = followed();
    next.agent = a;
    if (!a || a.app !== "claude-code") return;
    const st = await this.sessionOf(a);
    if (!st) return;
    next.session = { sessionId: st.sessionId, path: st.path };
    if (!withActivity) return;
    next.act = { prompt: st.prompt, steps: st.steps.slice(-STEPS), spinner: null };
    // Claude Code's own spinner line ("✢ Proofing… (1m 6s · ↓ 6.2k tokens)"), from the screen.
    if (a.status === "working") {
      const sc = await exec("hc", ["read", a.address, "--lines", "40"], { timeout: 5000 }).catch(() => null);
      for (const l of (sc?.stdout ?? "").split("\n").reverse()) {
        const m = /^\s*\S\s+([A-Z][^\s(]*…)\s*(?:\(([^)]*)\))?/.exec(l);
        if (m) { next.act.spinner = { verb: m[1], info: (m[2] ?? "").split(" · ").slice(0, 2).join(" · ") }; break; }
      }
    }
  }

  // Reads only what the log gained since last time. The first read starts TAIL_BYTES from the
  // end for steps, takes the last prompt from the log's "last-prompt" records, and greps the
  // whole log once for plan paths.
  async readNew(st) {
    const size = Number((await exec("stat", ["-f", "%z", st.path]).catch(() => null))?.stdout?.trim());
    if (!size || size === st.offset) return;
    let skipFirst = false;
    if (st.offset == null || size < st.offset) {
      st.steps = []; st.open = new Map(); st.found = new Map(); st.seq = 0; st.planDirty = true; st.lastTask = null;
      // Plan paths, and agent dispatches naming a task (the last one is the task in progress).
      const g = await exec("grep", ["-E", "superpowers/(plans/|sdd)|Task [0-9]", st.path], { timeout: 10000 }).catch(() => null);
      for (const line of (g?.stdout ?? "").split("\n")) {
        let d; try { d = JSON.parse(line); } catch { continue; }
        mention(st.found, d, st.base, st.seq++);
        if (d.type === "assistant" && !d.isSidechain && Array.isArray(d.message?.content)) {
          for (const x of d.message.content) if (x.type === "tool_use") { const n = taskOf(x); if (n != null) st.lastTask = n; }
        }
      }
      const lp = await exec("grep", ["-F", "\"type\":\"last-prompt\"", st.path], { timeout: 10000 }).catch(() => null);
      for (const line of (lp?.stdout ?? "").split("\n")) {
        try { const d = JSON.parse(line); if (d.lastPrompt) st.prompt = oneLine(d.lastPrompt); } catch {}
      }
      st.offset = Math.max(0, size - TAIL_BYTES);
      skipFirst = st.offset > 0; // starts mid-line
    }
    const r = await exec("tail", ["-c", `+${st.offset + 1}`, st.path], { timeout: 10000 }).catch(() => null);
    const text = r?.stdout ?? "";
    const end = text.lastIndexOf("\n");
    if (end < 0) return; // only a line still being written
    const chunk = text.slice(0, end + 1);
    st.offset += utf8Len(chunk);
    const lines = chunk.split("\n");
    if (skipFirst) lines.shift();
    for (const line of lines) {
      if (!line) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (line.includes("superpowers/") && mention(st.found, d, st.base, st.seq)) st.planDirty = true;
      st.seq++;
      consume(st, d);
    }
  }

  // The plan the session owns most ({plan} or {dir}); recomputed when new paths showed up.
  async sessionPlan(st) {
    if (!st.planDirty) return st.want;
    const best = new Map(); // plan path -> { score, seq, dir }
    for (const [p, v] of st.found) {
      if (v.score < 2) continue; // reading a plan doesn't make it this session's
      let plan = p, dir = null;
      if (p.includes("/.superpowers/sdd")) {
        // A workspace stands for its plan.
        dir = p;
        const marker = ((await readTextFile(`${p}/plan-path`).catch(() => null)) ?? "").trim();
        const ref = marker || parseLedger((await readTextFile(`${p}/progress.md`).catch(() => null)) ?? "").plan;
        if (!ref) continue;
        plan = ref.startsWith("/") ? ref : `${repoOf(p)}/${ref}`;
      } else if ((await readTextFile(p).catch(() => null)) == null) continue; // named, but not there
      const prev = best.get(plan);
      best.set(plan, {
        score: Math.max(prev?.score ?? 0, v.score), seq: Math.max(prev?.seq ?? -1, v.seq),
        dir: dir ?? prev?.dir ?? null,
      });
    }
    const top = [...best].sort((a, b) => b[1].score - a[1].score || b[1].seq - a[1].seq)[0];
    st.want = top ? (top[1].dir ? { plan: top[0], dir: top[1].dir } : { plan: top[0] }) : null;
    st.planDirty = false;
    return st.want;
  }

  toggle(key, cx, report) {
    if (this.expanded.has(key)) this.expanded.delete(key);
    else {
      this.expanded.add(key);
      if (report && !this.reports.has(report)) {
        cx.spawn(async (cx) => { this.reports.set(report, (await readTextFile(report).catch(() => null)) ?? ""); cx.notify(); });
      }
    }
    cx.notify();
  }

  // The expanded part under a row: markdown, selectable.
  detail(t, id, md) {
    return div().ml(24).mt(4).mb(6).p(10).rounded(6).bg(t.surface).border_1().border_color(t.border)
      .text_size(12).text_color(t.foreground)
      .child(TextView.markdown(id, md).selectable(true));
  }

  stepMarkdown(st) {
    if (st.kind === "text") return st.full;
    const out = st.output == null ? (st.running ? "_running\u2026_" : "")
      : st.output.trim() ? `**${st.error ? "Error" : "Output"}**\n\n${fence(st.output.split("\n").slice(-40).join("\n"))}` : "_no output_";
    return `${st.detail}\n\n${out}`;
  }

  taskMarkdown(task) {
    const parts = [];
    if (task.ledgerLine) parts.push(`**Ledger:** ${task.ledgerLine}`);
    if (task.report) {
      const r = this.reports.get(task.report);
      parts.push(r == null ? "_Loading report\u2026_" : `**Report**\n\n${clip(r)}`);
    }
    if (task.body) parts.push(`**Plan**\n\n${clip(task.body, 8000)}`);
    return parts.join("\n\n---\n\n") || "_Nothing more in the plan for this task._";
  }

  togglePanel() {
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === "tasks")) return;
    if (!panel.hidden && body.active === "tasks") return run("layout.hide", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "tasks" });
    run("layout.show", { id: "panel" });
  }

  counts() {
    const tasks = this.data?.tasks ?? [];
    return { done: tasks.filter((x) => x.state === "done").length, total: tasks.length };
  }

  render(cx) {
    // A switch of agent or folder (another space, tab or pane) refreshes now, not on the next tick.
    const key = `${followed()?.address ?? ""}|${location() ?? ""}`;
    if (key !== this.followKey) {
      if (this.followKey !== undefined) cx.timer.after(1, (cx) => this.refresh(cx));
      this.followKey = key;
    }
    return props()?.compact ? this.renderChip() : this.renderPanel();
  }

  renderChip() {
    const t = theme();
    const { done, total } = this.counts();
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "tasks";
    const working = this.data?.tasks?.some((x) => x.state === "working");
    // Painted like the tab bar it sits in (as the Pomodoro chip is): its colour and bottom line.
    // Left-aligned in a block just wider than the pill, so it sits as close to Simulator as the
    // tab bar's own buttons sit to each other.
    return h_flex().id("tasks-chip").size_full().items_center().justify_start().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("tasks-chip-btn").min_w(67).justify_center().h(26).px(8).gap(5).items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click(() => this.togglePanel())
        .child(working ? svg(SPINNER).size(12).text_color(t.working).spin(900) : svg(ICON("list")).size(14))
        .child(total ? `${done}/${total}` : "Tasks"));
  }

  renderAgent(t) {
    const a = this.agent, act = this.act;
    const color = t[a.status] ?? t.muted;
    const live = (st) => st.running && a.status === "working";
    const step = (st) => {
      const open = this.expanded.has(st.key);
      return v_flex().id(`step-${st.key}`)
        .child(h_flex().id(`step-row-${st.key}`).min_h(22).py(2).px(4).gap(8).items_start().rounded(5)
          .hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.toggle(st.key, cx))
          .child(div().flex_none().w(14).pt(1).child(
            st.kind === "text" ? div().pl(3).text_color(t.dim).child("\u203a")
              : live(st) ? svg(SPINNER).size(12).text_color(t.working).spin(900)
              : div().size(6).mt(4).ml(3).rounded(3).bg(st.error ? t.blocked : t.dim)))
          .child(div().flex_1().min_w(0).text_size(12)
            .text_color(live(st) ? t.foreground : st.error ? t.blocked : t.muted)
            .when(st.kind === "text", (el) => el.italic())
            .when(!open, (el) => el.truncate())
            .child(st.text)))
        .when(open, (el) => el.child(this.detail(t, `step-md-${st.key}`, this.stepMarkdown(st))));
    };
    const busy = a.status === "working" && !(act?.steps ?? []).some(live);
    return v_flex().pb(14).mb(12).border_b(1).border_color(t.border)
      .child(h_flex().pb(6).gap(6).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.dim).child("AGENT"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(a.title || a.tab_name || a.address))
        .child(div().size(6).rounded(3).bg(color))
        .child(div().text_size(11).text_color(color).child(a.status ?? "")))
      .when(a.app !== "claude-code", (el) => el.child(div().text_size(12).text_color(t.dim).child(`${a.program?.name ?? a.app ?? "Agent"}: activity is only read for Claude Code`)))
      .when(a.app === "claude-code" && !act, (el) => el.child(div().text_size(12).text_color(t.dim).child("No session log found")))
      .when(Boolean(act?.prompt), (el) => el.child(div().pb(6).text_size(12).text_color(t.muted).child(`\u203a ${act.prompt}`)))
      .children((act?.steps ?? []).map(step))
      .when(busy, (el) => el.child(h_flex().min_h(22).py(2).px(4).gap(8).items_center()
        .child(div().flex_none().w(14).child(svg(SPINNER).size(12).text_color(t.working).spin(900)))
        .child(div().text_size(12).text_color(t.foreground).child(act?.spinner?.verb ?? "Working\u2026"))
        .when(Boolean(act?.spinner?.info), (el) => el.child(div().text_size(11).text_color(t.dim).child(act.spinner.info)))));
  }

  renderPanel() {
    const t = theme();
    const d = this.data, rp = d ? null : this.repoPlan;
    const { done, total } = this.counts();
    const row = (plan) => (task) => {
      const icon = task.state === "done" ? svg(ICON("done")).size(15).text_color(t.dim)
        : task.state === "working" ? svg(SPINNER).size(15).text_color(t.working).spin(900)
        : svg(ICON("pending")).size(15).text_color(t.dim);
      const key = `task-${plan.file}-${task.n}`, open = this.expanded.has(key);
      return v_flex().id(key)
        .child(h_flex().id(`${key}-row`).min_h(28).py(4).px(4).gap(10).items_start().rounded(5)
          .hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.toggle(key, cx, task.report))
          .child(div().pt(1).flex_none().child(icon))
          .child(div().flex_1().min_w(0).text_size(13)
            .text_color(task.state === "done" ? t.muted : t.foreground)
            .child(task.name))
          .when(task.state !== "done" && task.checked > 0, (el) => el.child(div().flex_none().pt(1).text_size(11).text_color(t.dim)
            .child(`${task.checked}/${task.steps}`))))
        .when(open, (el) => el.child(this.detail(t, `${key}-md`, this.taskMarkdown(task))));
    };
    const close = h_flex().id("tasks-close").size(22).items_center().justify_center().rounded(5).text_color(t.muted)
      .hover((s) => s.bg(t.hover)).on_click(() => run("layout.hide", { id: "panel" }))
      .child(svg("mods/pane/close.svg").size(12));
    return v_flex().id("root").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_size(12).text_color(t.foreground)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Tasks"))
        .when(Boolean(d), (el) => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(total && done === total ? "Done" : d.tasks.some((x) => x.state === "working") ? "Running" : d.started ? "Paused" : "Planned")))
        .child(div().flex_1())
        .child(close))
      .child(v_flex().id("tasks-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(2)
        .when(Boolean(this.agent), (el) => el.child(this.renderAgent(t)))
        .child(div().pb(6).text_size(11).font_semibold().text_color(t.dim).child("PLAN"))
        .when(Boolean(d), (el) => el
          .child(div().pb(6).text_size(12).font_semibold().text_color(t.muted).child(d.title))
          .when(!d.tasks.length, (el) => el.child(div().text_color(t.dim).child("No \"### Task N:\" headings in the plan")))
          .children(d.tasks.map(row(d))))
        .when(!d && Boolean(rp), (el) => el
          .child(h_flex().id("repo-plan").min_h(28).py(4).px(4).gap(8).items_start().rounded(5)
            .hover((h) => h.bg(t.hover)).on_click((_e, cx) => { this.showRepo = !this.showRepo; cx.notify(); })
            .child(div().flex_none().w(12).text_color(t.dim).child(this.showRepo ? "\u25be" : "\u25b8"))
            .child(div().flex_1().min_w(0).text_size(12).text_color(t.muted)
              .child(`No plan in this session. Latest in ${basename(this.root)}: ${rp.title}`))
            .child(div().flex_none().text_size(11).text_color(t.dim)
              .child(`${rp.tasks.filter((x) => x.state === "done").length}/${rp.tasks.length}`)))
          .when(this.showRepo, (el) => el.children(rp.tasks.map(row(rp)))))
        .when(!d && !rp, (el) => el.child(div().text_color(t.dim)
          .child(this.agent && !this.session ? (this.note ?? "") : this.note ? `No plan in this session. ${this.note}` : ""))))
      .child(h_flex().flex_none().px(14).h(36).items_center().gap(8).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(d?.file ? `${basename(repoOf(d.file) ?? "")} / ${basename(d.file)}` : (this.root ? basename(this.root) : "")))
        .when(total > 0, (el) => el.child(`${done}/${total} done`)));
  }
}
