// What the agents did while you were on a break, kept in shared("pomodoro.away").
//
// A record opens when a break starts running and closes when a focus starts
// running (a Simple break that ends waits for Start, so you're still away until
// then). It stays shown until dismissed or replaced by the next break's.
// Finished: agents seen working that later went done or idle before it closed.
// Needs you is live (every blocked agent); `blocked` only remembers since when.

import { agents, shared, setShared } from "herdr";

const AWAY = "pomodoro.away";

export const away = () => shared(AWAY) ?? null;

export const dismiss = () => {
  const a = away();
  if (a) setShared(AWAY, { ...a, dismissed: true });
};

// Keyed by address, so every copy watching at once writes the same thing.
function observe(a, now) {
  const list = agents();
  const live = new Set(list.map((x) => x.address));
  for (const x of list) {
    if (x.status === "working") a.working[x.address] = true;
    else if ((x.status === "done" || x.status === "idle") && a.working[x.address]) {
      delete a.working[x.address];
      a.finished[x.address] = { at: now, name: name(x), space: x.space_name };
    }
    if (x.status === "blocked") { if (!(x.address in a.blocked)) a.blocked[x.address] = now; }
    else delete a.blocked[x.address];
  }
  for (const seen of [a.working, a.blocked])
    for (const address of Object.keys(seen)) if (!live.has(address)) delete seen[address];
}

// Called every second by each copy with the timer's state.
export function track(s, now = Date.now()) {
  const was = away();
  let a = was && JSON.parse(JSON.stringify(was));
  if (s.phase !== "focus" && s.running && (!a || a.to != null)) {
    a = { from: now, to: null, working: {}, finished: {}, blocked: {} };
    observe(a, now);
    // Already waiting on you when the break began: no time of its own.
    for (const address of Object.keys(a.blocked)) a.blocked[address] = null;
  } else if (a && a.to == null) {
    if (s.phase === "focus" && s.running) a.to = now;
    else observe(a, now);
  }
  if (a && JSON.stringify(a) !== JSON.stringify(was)) setShared(AWAY, a);
}

// The tab's name unless it's just a number, else the agent's title or program.
export const name = (x) =>
  (x.tab_name && !/^\d+$/.test(x.tab_name) ? x.tab_name : "") || x.title || x.program?.name || x.address;
