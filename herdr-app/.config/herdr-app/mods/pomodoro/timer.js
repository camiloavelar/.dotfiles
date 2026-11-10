// The timer, kept in shared("pomodoro") as an end time so every copy agrees,
// and the saved sessions in shared("pomodoro.sessions").
//
// Simple: focus, short break, long break after every 4th focus; each phase
// waits for Start. Session: a saved list of steps run one after another, each
// starting by itself when the one before ends. A step's length is the setting
// for its phase (s.minutes) unless the step pins its own (`min`).

import { shared, setShared } from "herdr";

export const KEY = "pomodoro";
const SESSIONS = "pomodoro.sessions";
export const PHASES = {
  // Tomato red: the terminal palette's red, so it follows the theme.
  focus: { label: "Focus", color: "ansi1" },
  short: { label: "Short break", color: "done" },
  long: { label: "Long break", color: "working" },
};
export const DEFAULT_MINUTES = { focus: 25, short: 5, long: 15 };
export const ROUNDS = 4;

export const ms = (min) => min * 60000;
export const midnight = () => new Date().setHours(0, 0, 0, 0);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fresh() {
  return { phase: "focus", running: false, endsAt: null, segStart: null, left: ms(DEFAULT_MINUTES.focus), total: null,
    round: 0, minutes: { ...DEFAULT_MINUTES }, day: today(), sessions: 0, focusMs: 0, cmd: null, run: null };
}

// A new day starts the counts over; a focus running past midnight counts from midnight.
export function load() {
  const s = { ...fresh(), ...(shared(KEY) ?? {}) };
  s.minutes = { ...DEFAULT_MINUTES, ...s.minutes };
  s.total ??= ms(s.minutes[s.phase]);
  if (s.day !== today()) {
    Object.assign(s, { day: today(), sessions: 0, focusMs: 0 });
    if (s.segStart != null) s.segStart = Math.max(s.segStart, midnight());
  }
  return s;
}

export const save = (s) => setShared(KEY, s);

export function remaining(s, now = Date.now()) {
  return s.running ? Math.max(0, s.endsAt - now) : s.left;
}

export const untouched = (s) => !s.running && s.left === s.total;

export function clock(t) {
  const sec = Math.ceil(t / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export function hours(t) {
  const min = Math.floor(t / 60000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

// Time focused in the running segment (never past its end), counted into today's total.
export function focusedSoFar(s, until) {
  if (s.phase !== "focus" || s.segStart == null) return 0;
  return Math.max(0, Math.min(until, s.endsAt ?? until) - s.segStart);
}

function credit(s, until) {
  s.focusMs += focusedSoFar(s, until);
  s.segStart = null;
}

function enter(s, phase, min = s.minutes[phase]) {
  Object.assign(s, { phase, running: false, endsAt: null, segStart: null, total: ms(min), left: ms(min) });
}

function start(s, now) {
  Object.assign(s, { running: true, endsAt: now + s.left, segStart: now });
}

// The session's next step, or back to a simple focus once its last step is done.
function advance(s) {
  const next = s.run.step + 1;
  if (next >= s.run.steps.length) {
    s.run = null;
    enter(s, "focus");
    return false;
  }
  s.run.step = next;
  enter(s, s.run.steps[next].phase, stepMin(s.minutes, s.run.steps[next]));
  return true;
}

// Ends the phase whose time is up. Returns the toast to show, or null when it
// ended before today (nobody needs to hear about it).
export function finish(s, now) {
  const ended = s.phase, endsAt = s.endsAt, todays = endsAt >= midnight(), late = now - endsAt > 5000;
  credit(s, endsAt);
  if (ended === "focus" && todays) s.sessions += 1;
  let title = ended === "focus" ? "Focus done" : "Break over", body;
  if (s.run) {
    const { name, steps } = s.run;
    if (advance(s)) {
      // Straight on from the step before, unless nobody was here to see it end.
      if (!late) Object.assign(s, { running: true, segStart: endsAt, endsAt: endsAt + s.total });
      body = `Next: ${PHASES[s.phase].label}, ${s.total / 60000} min (step ${s.run.step + 1} of ${steps.length}).`;
    } else {
      title = "Session complete";
      body = `${name}: all ${steps.length} steps done.`;
    }
  } else if (ended === "focus") {
    s.round += 1;
    enter(s, s.round >= ROUNDS ? "long" : "short");
    if (s.round >= ROUNDS) s.round = 0;
    body = `Time for a ${PHASES[s.phase].label.toLowerCase()} (${s.minutes[s.phase]} min).`;
  } else {
    enter(s, "focus");
    body = `Back to focus (${s.minutes.focus} min).`;
  }
  if (!todays) return null;
  return { late, title: late ? `${title} while Pomodoro was closed` : title, body,
    level: ended === "focus" || title === "Session complete" ? "success" : "info" };
}

export const MAX_MINUTES = 180;

// A phase's length in Simple. The shown clock follows it if that phase hasn't
// started yet; otherwise it applies from the next time.
function setMinutes(s, phase, min) {
  if (!PHASES[phase] || !Number.isFinite(min)) return;
  const waiting = !s.run && s.phase === phase && untouched(s);
  s.minutes[phase] = Math.min(MAX_MINUTES, Math.max(1, Math.round(min)));
  if (waiting) enter(s, phase);
}

function adjust(s, delta) {
  if (s.run || !untouched(s)) return;
  setMinutes(s, s.phase, s.minutes[s.phase] + delta);
}

// What buttons and keys do. Each gets a fresh state to change; the caller saves it.
export const ACTIONS = {
  toggle(s, now) {
    if (s.running) {
      s.left = remaining(s, now);
      credit(s, now);
      Object.assign(s, { running: false, endsAt: null });
    } else {
      start(s, now);
    }
  },
  reset(s, now) {
    credit(s, now);
    enter(s, s.phase, s.total / 60000);
  },
  skip(s, now) {
    const was = s.running;
    credit(s, now);
    if (!s.run) return enter(s, s.phase === "focus" ? "short" : "focus");
    if (advance(s) && was) start(s, now);
  },
  // Ends a running session; the timer goes back to a simple focus.
  stop(s, now) {
    credit(s, now);
    s.run = null;
    enter(s, "focus");
  },
  pick(s, now, phase) {
    credit(s, now);
    s.run = null;
    enter(s, phase);
  },
  begin(s, now, session) {
    if (!session?.steps?.length) return;
    credit(s, now);
    const steps = session.locked ? session.steps.map((st) => ({ phase: st.phase, min: stepMin(session.locked, st) })) : session.steps.map((st) => ({ ...st }));
    s.run = { id: session.id, name: session.name, steps, step: 0 };
    enter(s, s.run.steps[0].phase, stepMin(s.minutes, s.run.steps[0]));
    start(s, now);
  },
  more: (s) => adjust(s, 1),
  less: (s) => adjust(s, -1),
  minutes: (s, _now, { phase, min }) => setMinutes(s, phase, min),
  defaults(s) {
    for (const [phase, min] of Object.entries(DEFAULT_MINUTES)) setMinutes(s, phase, min);
  },
};

// Classic follows the settings; Deep work and 52 / 17 are their lengths, so they're pinned.
const PRESETS = [
  { id: "classic", name: "Classic", steps: [["focus"], ["short"], ["focus"], ["short"], ["focus"], ["short"], ["focus"], ["long"]] },
  { id: "deep", name: "Deep work", steps: [["focus", 50], ["short", 10], ["focus", 50], ["long", 20]] },
  { id: "52-17", name: "52 / 17", steps: [["focus", 52], ["short", 17], ["focus", 52], ["short", 17]] },
].map((p) => ({ ...p, v: 2, steps: p.steps.map(([phase, min = null]) => ({ phase, min })) }));

export const stepMin = (minutes, st) => st.min ?? minutes[st.phase];

// A locked session keeps the lengths it had when locked (`locked`: the settings
// then); otherwise its unpinned steps follow the settings.
export const lengthsOf = (session, minutes) => session.locked ?? minutes;

// Sessions saved before steps could follow the settings wrote every length out:
// a length equal to the old default becomes "follow the setting".
const migrate = (se) => se.v === 2 ? se
  : { ...se, v: 2, steps: se.steps.map((st) => ({ phase: st.phase, min: st.min === DEFAULT_MINUTES[st.phase] ? null : st.min ?? null })) };

const same = (a, b) => a.name === b.name && JSON.stringify(a.steps.map((st) => [st.phase, st.min]))
  === JSON.stringify(b.steps.map((st) => [st.phase, st.min]));

// The person's own sessions. Built-ins were once saved here too: an unchanged
// one is dropped (the built-in shows), an edited one stays as their own.
function custom() {
  const list = shared(SESSIONS);
  if (!Array.isArray(list)) return [];
  return list.map(migrate).flatMap((se) => {
    const preset = PRESETS.find((p) => p.id === se.id);
    if (!preset) return [se];
    return same(se, preset) ? [] : [{ ...se, id: `${se.id}-edited`, name: `${se.name} (edited)` }];
  });
}

// Built-ins first (read-only: clone one to change it), then the person's own.
export function sessions() {
  return [...PRESETS.map((p) => ({ ...p, builtin: true })), ...custom()];
}

export const saveSessions = (list) =>
  setShared(SESSIONS, list.filter((se) => !se.builtin).map(({ builtin, ...se }) => migrate(se)));

export function clone(session, list = sessions()) {
  const names = new Set(list.map((se) => se.name));
  let name = `${session.name} copy`;
  for (let n = 2; names.has(name); n++) name = `${session.name} copy ${n}`;
  return { id: `s${Date.now()}`, name, v: 2, steps: session.steps.map((st) => ({ ...st })) };
}

export function summary(session, minutes) {
  const focus = session.steps.filter((st) => st.phase === "focus");
  const total = session.steps.reduce((n, st) => n + stepMin(lengthsOf(session, minutes), st), 0);
  return `${focus.length} focus · ${hours(ms(total))}`;
}
