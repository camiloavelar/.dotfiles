import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme, appHome, shared, setShared, nextCommand, props, layout } from "herdr";
import net from "net";
import { writeFile } from "fs/promises";
import { serveSim, startHelper, keyUsages, touchEdge } from "./serve-sim.js";
import { SDK, startAndroid } from "./android.js";

// Frames (serve-sim's MJPEG on iOS, android-stream.mjs's PNGs on Android) go to another mod's folder. Herdr refreshes
// images under mods/ when they change, but a write inside this mod's own
// folder would reload this mod. A changed image keeps its old picture for
// ~175 ms, then reloads, blank meanwhile. So frames rotate through a ring of
// files stacked under the one on show, and each moves to the top once it has
// reloaded; restacking images costs nothing.
// Each view (the panel, each pane) needs its own files, or one overwrites the
// frame another has on show. A layout block names its view in props; a pane
// can't learn its own id, so it takes the lowest free pane-N. Slots are reused
// rather than made unique because Herdr never evicts an image path it loaded.
const RING = 12;
const frameFiles = (set) => Array.from({ length: RING }, (_, i) => `mods/herdr-sim-screen/${set}-${i}.jpg`);
const RELOAD_MS = 200;
// ~30 fps, as smooth as a swipe needs; each file in the ring holds a decoded
// full-size frame (~12 MB). Writes catch up by at most one FRAME_MS, so a file
// is rewritten (RING - 1) * FRAME_MS after its last write at the soonest, well
// after it stopped being on show.
const FRAME_MS = 33;
// The device each view shows, by view, and the last one picked anywhere. A
// view with no choice of its own keeps the one last picked when it opened, so
// a pick in another view doesn't move it; else it shows the first booted one.
const CHOICES = "herdr-sim.devices";
const LAST_PICKED = "herdr-sim.device";
// Slots taken by open panes. globalThis is shared by every copy and starts
// empty when Herdr does.
const panes = (globalThis.__herdrSimPanes ??= new Set());

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function claimPaneSlot() {
  for (let i = 1; ; i++) {
    if (!panes.has(`pane-${i}`)) {
      panes.add(`pane-${i}`);
      return `pane-${i}`;
    }
  }
}
const HEADER = 44;
const TOOLBAR = 28;
const BEZEL = 10;
const PAD = 12;
const ICONS = "mods/herdr-sim/icons";
// Pixels per line, for a wheel that reports lines.
const LINE = 20;
// The HID consumer page, where volume up is 233 and down 234.
const CONSUMER = 12;

const BUTTONS = [
  { id: "home", icon: "house", tip: "Home", press: (input) => input.button("home") },
  { id: "lock", icon: "lock", tip: "Lock", press: (input) => input.button("lock") },
  { id: "volume-down", icon: "volume-1", tip: "Volume down", press: (input) => input.hid(CONSUMER, 234) },
  { id: "volume-up", icon: "volume-2", tip: "Volume up", press: (input) => input.hid(CONSUMER, 233) },
  { id: "rotate", icon: "rotate-ccw", tip: "Rotate", press: (input) => input.rotate() },
  { id: "keyboard", icon: "keyboard", tip: "Show or hide the software keyboard", press: (input) => input.softwareKeyboard(), only: "ios" },
];

const sleep = (cx, ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The pointer as a 0..1 fraction of the element it is over.
function fraction(e) {
  const p = e.local_position;
  const b = e.bounds;
  return p && b ? { x: clamp(p.x / b.width, 0, 1), y: clamp(p.y / b.height, 0, 1) } : null;
}

// com.apple.CoreSimulator.SimRuntime.iOS-27-2 -> "iOS 27.2"
function runtimeLabel(key) {
  const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(key);
  return m ? `iOS ${m[1]}.${m[2]}` : null;
}

async function listSimulators() {
  const r = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "xcrun simctl failed");
  return Object.entries(JSON.parse(r.stdout).devices)
    .flatMap(([key, devices]) => {
      const os = runtimeLabel(key);
      return os ? devices.map((d) => ({ platform: "ios", id: d.udid, name: d.name, os, booted: d.state === "Booted" })) : [];
    })
    .sort((a, b) => b.os.localeCompare(a.os, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

// Prints "host <arch>", "avd <name> <abi> <api level>" per emulator, then
// "on <name>" per running one.
const LIST_AVDS = `${SDK}
[ -x "$sdk/emulator/emulator" ] || exit 0
echo "host $(uname -m)"
for a in $("$sdk/emulator/emulator" -list-avds 2>/dev/null | grep -E '^[A-Za-z0-9._-]+$'); do
  c="$HOME/.android/avd/$a.avd/config.ini"
  echo "avd $a $(sed -n 's|^abi.type=||p' "$c" 2>/dev/null) $(sed -n 's|^image.sysdir.1=system-images/android-\\([0-9]*\\).*|\\1|p' "$c" 2>/dev/null)"
done
for s in $("$sdk/platform-tools/adb" devices 2>/dev/null | awk '/^emulator-/ {print $1}'); do
  echo "on $("$sdk/platform-tools/adb" -s "$s" emu avd name 2>/dev/null | head -1 | tr -d '\\r')"
done`;

async function listEmulators() {
  const r = await exec("sh", ["-c", LIST_AVDS]);
  const lines = r.stdout.split("\n").map((l) => l.trim().split(" "));
  const running = new Set(lines.filter(([kind]) => kind === "on").map(([, name]) => name));
  // The emulator only runs images built for the Mac's own CPU.
  const host = lines.find(([kind]) => kind === "host")?.[1] === "arm64" ? "arm" : "x86";
  return lines.filter(([kind]) => kind === "avd").map(([, name, abi, api]) => ({
    platform: "android", id: `avd:${name}`, avd: name, name: name.replaceAll("_", " "),
    os: api ? `Android API ${api}` : "Android", booted: running.has(name),
    unusable: abi && !abi.startsWith(host) ? `${abi} image, can't run on this Mac` : null,
  }));
}

// Grouped in the picker in this order. `start` opens a session: the device, its
// input, and the host, port and path of a multipart stream of its frames.
const PLATFORMS = [
  { id: "android", label: "Android", icon: "android", list: listEmulators,
    boot: (d) => exec("sh", ["-c", `${SDK}; nohup "$sdk/emulator/emulator" -avd "$1" -no-window -no-audio >/dev/null 2>&1 &`, "sh", d.avd]),
    start: startAndroid },
  { id: "ios", label: "iOS", icon: "apple", list: listSimulators,
    boot: (d) => exec("xcrun", ["simctl", "boot", d.id]),
    start: startHelper },
];
const platformOf = (d) => PLATFORMS.find((p) => p.id === d.platform);

async function listDevices() {
  return (await Promise.all(PLATFORMS.map((p) => p.list()))).flat();
}

function headerEnd(buf, len) {
  for (let i = 0; i + 3 < len; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

// Width over height, from a PNG's IHDR or a JPEG's start-of-frame.
function imageAspect(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const u32 = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
    return u32(16) / u32(20);
  }
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return ((bytes[i + 7] << 8) | bytes[i + 8]) / ((bytes[i + 5] << 8) | bytes[i + 6]);
    }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

export default class Simulator extends View {
  init(_props, cx) {
    // phase: no-device | shutdown | booting | starting | repairing | live | error
    this.phase = { kind: "starting", device: null };
    // The pressed point of the gesture in progress, or null.
    this.touch = null;
    // Held key usage -> the modifier usages pressed with it.
    this.keys = new Map();
    this.devices = [];
    this.picking = false;
    this.booting = new Set();
    this.repairing = null;
    this.view = props()?.frames ?? claimPaneSlot();
    this.frames = frameFiles(this.view);
    this.opened = shared(LAST_PICKED);
    // Indexes into this.frames, bottom to top; the last is on show.
    this.stack = this.frames.map((_, i) => i);
    this.next = 0;
    this.aspect = 1260 / 2736;
    this.size = { width: 360, height: 720 };
    this.focus = cx.focus_handle();
    this.session = null;
    this.socket = null;
    this.closed = false;
    cx.spawn((cx) => this.run(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.focus.focus();
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    panes.delete(this.view);
    this.socket?.close();
    await this.release();
  }

  async release(kill = false) {
    const session = this.session;
    this.session = null;
    session?.input.close();
    if (session?.device.platform === "ios" && (session.owned || kill)) await serveSim(["--kill", session.device.id]);
  }

  // The device to show: the picked one, else the first booted one.
  target() {
    const picked = shared(CHOICES)?.[this.view] ?? this.opened;
    return this.devices.find((d) => d.id === picked) ?? this.devices.find((d) => d.booted) ?? null;
  }

  set(phase, cx) {
    this.phase = phase;
    if (phase.kind !== "live") {
      this.touch = null;
      this.keys.clear();
    }
    cx.notify();
  }

  async pick(device, cx) {
    this.picking = false;
    setShared(CHOICES, { ...shared(CHOICES), [this.view]: device.id });
    setShared(LAST_PICKED, device.id);
    this.socket?.close();
    if (!device.booted && !this.booting.has(device.id)) {
      this.booting.add(device.id);
      cx.notify();
      await platformOf(device).boot(device);
    }
  }

  repairInput(device) {
    this.picking = false;
    this.repairing = device.id;
    this.socket?.close();
  }

  // Herdr keeps a copy running once it has shown, so the panel's copy goes on
  // while the panel is closed or on Files or Changes; it stops streaming then.
  // A pane can't tell whether its tab shows, so panes always stream.
  hidden() {
    if (this.view !== "panel") return false;
    const root = layout();
    const panel = findNode(root, "panel");
    return !panel || panel.hidden || findNode(root, "panel-body")?.active !== "herdr-sim";
  }

  async run(cx) {
    while (!this.closed) {
      let device = null;
      try {
        if (this.hidden()) {
          this.socket?.close();
          this.paused = true;
          await sleep(cx, 500);
          continue;
        }
        this.devices = await listDevices();
        device = this.target();
        if (!device) {
          this.set({ kind: "no-device" }, cx);
          await sleep(cx, 2000);
          continue;
        }
        if (!device.booted) {
          this.set({ kind: this.booting.has(device.id) ? "booting" : "shutdown", device }, cx);
          await sleep(cx, 1000);
          continue;
        }
        this.booting.delete(device.id);
        if (this.repairing === device.id) {
          this.repairing = null;
          this.set({ kind: "repairing", device }, cx);
          await serveSim(["repair-input", "-d", device.id]);
          // A running serve-sim keeps the input it opened before the repair.
          await this.release(true);
        }
        const platform = platformOf(device);
        if (this.session?.device.id !== device.id) {
          await this.release();
          this.set({ kind: "starting", device }, cx);
          this.session = await platform.start(device);
        } else if (this.paused && device.platform === "android") {
          // Its frame helper exits once nothing watches; starting again reuses it if it didn't.
          this.session = await platform.start(device);
        }
        this.paused = false;
        await this.stream(cx);
      } catch (e) {
        if (this.closed) return;
        await this.release();
        this.set({ kind: "error", device, message: String(e.message ?? e) }, cx);
        await sleep(cx, 5000);
      }
    }
  }

  async stream(cx) {
    const { device, host, port, path } = this.session;
    const socket = await net.connect(host, port);
    this.socket = socket;
    await socket.write(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
    let buf = new Uint8Array(1 << 20);
    let len = 0;
    // When the next frame is due: a schedule rather than a gap since the last
    // write, or uneven arrivals skip two frames where one would do.
    let due = 0;
    read: for (;;) {
      // A read on a socket closed here (a pick, a repair) ends the stream like EOF.
      const chunk = await socket.read(1 << 16).catch(() => null);
      if (chunk == null || this.closed || this.repairing || this.target()?.id !== device.id) break;
      if (len + chunk.length > buf.length) {
        const grown = new Uint8Array((len + chunk.length) * 2);
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(chunk, len);
      len += chunk.length;
      for (;;) {
        const head = headerEnd(buf, Math.min(len, 4096));
        if (head < 0) break;
        const length = /Content-Length: (\d+)/i.exec(String.fromCharCode(...buf.subarray(0, head)));
        const start = head + 4;
        const end = length ? start + Number(length[1]) : start;
        if (len < end) break;
        const now = Date.now();
        if (length && now >= due) {
          if (this.hidden()) break read;
          due = Math.max(due, now - FRAME_MS) + FRAME_MS;
          const frame = buf.slice(start, end);
          this.aspect = imageAspect(frame) ?? this.aspect;
          const slot = this.next;
          this.next = (slot + 1) % RING;
          await writeFile(`${appHome()}/${this.frames[slot]}`, frame);
          if (this.phase.kind !== "live") this.phase = { kind: "live", device };
          cx.timer.after(RELOAD_MS, (cx) => this.promote(slot, cx));
        }
        buf.copyWithin(0, end, len);
        len -= end;
      }
    }
    socket.close();
    this.socket = null;
  }

  promote(slot, cx) {
    this.stack = [...this.stack.filter((i) => i !== slot), slot];
    cx.notify();
  }

  // Ends the gesture where the pointer let go, or where it last was.
  lift(p) {
    const touch = this.touch;
    if (!touch) return;
    this.touch = null;
    this.session?.input.touch("end", p ?? touch, touch.edge);
  }

  keyDown(e, cx) {
    const input = this.session?.input;
    const k = input && keyUsages(e);
    if (!k) return;
    cx.stop_propagation();
    // A held key repeats here; iOS repeats it on its own.
    if (this.keys.has(k.usage)) return;
    this.keys.set(k.usage, k.modifiers);
    for (const m of k.modifiers) input.key("down", m);
    input.key("down", k.usage);
  }

  keyUp(e, cx) {
    const input = this.session?.input;
    const k = input && keyUsages(e);
    const modifiers = k && this.keys.get(k.usage);
    if (!modifiers) return;
    cx.stop_propagation();
    this.keys.delete(k.usage);
    input.key("up", k.usage);
    for (const m of [...modifiers].reverse()) input.key("up", m);
  }

  note() {
    const p = this.phase;
    switch (p.kind) {
      case "live": return null;
      case "starting": return p.device ? `Connecting to ${p.device.name}…` : "Starting…";
      case "repairing": return `Repairing input on ${p.device.name}. SpringBoard restarts and apps close.`;
      case "booting": return `Booting ${p.device.name}…`;
      case "shutdown": return `${p.device.name} is shut down. Pick it again to boot it.`;
      case "no-device": return "Pick a device above";
      case "error": return p.message;
    }
  }

  selector(t) {
    const device = this.phase.device ?? this.target();
    const status = this.phase.kind === "live" ? t.ansi2 : this.phase.kind === "error" ? t.blocked : t.dim;
    return h_flex().id("simulator-select").h(HEADER - 8).px(10).gap(8).items_center().rounded(8)
      .border(1).border_color(t.border).bg(t.surface).cursor_pointer()
      .hover((el) => el.border_color(t.input))
      .on_click((_e, cx) => {
        this.picking = !this.picking;
        cx.notify();
        if (this.picking) cx.spawn(async (cx) => { this.devices = await listDevices(); cx.notify(); });
      })
      .child(svg(`${ICONS}/circle-check.svg`).size(15).flex_none().text_color(status))
      .child(div().flex_1().min_w(0).truncate().text_center().text_size(13).text_color(device ? t.foreground : t.muted)
        .child(device ? `${device.name} • ${device.os}` : "Select device"))
      .child(svg(`${ICONS}/chevrons-up-down.svg`).size(14).flex_none().text_color(t.dim));
  }

  menu(t) {
    const target = this.target();
    const groups = PLATFORMS
      .map((p) => ({ platform: p, devices: this.devices.filter((d) => d.platform === p.id) }))
      .filter((g) => g.devices.length);
    const rows = groups.flatMap(({ platform, devices }) => [
      div().px(10).pt(8).pb(4).text_size(11).text_color(t.dim).child(platform.label),
      ...devices.map((d) => h_flex().id(`device-${d.id}`).mx(4).px(8).py(6).gap(10).items_start().rounded(6).cursor_pointer()
        .when(d.id === target?.id, (el) => el.bg(t.selected))
        .when(d.unusable, (el) => el.opacity(0.5).cursor_default())
        .when(!d.unusable, (el) => el.hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.spawn((cx) => this.pick(d, cx)); cx.notify(); }))
        .child(svg(`${ICONS}/${platform.icon}.svg`).size(15).mt(2).flex_none().text_color(t.muted))
        .child(v_flex().flex_1().min_w(0)
          .child(h_flex().gap(6).items_center()
            .child(div().truncate().text_size(13).text_color(t.foreground).child(d.name))
            .when(d.booted, (el) => el.child(div().w(7).h(7).flex_none().rounded(4).bg(t.ansi2)))
            .when(this.booting.has(d.id), (el) => el.child(div().text_size(11).text_color(t.dim).child("booting"))))
          .child(div().text_size(11).text_color(t.dim).child(d.unusable ? `${d.os} · ${d.unusable}` : d.os)))
        .when(d.id === target?.id, (el) => el.child(svg(`${ICONS}/check.svg`).size(14).mt(2).flex_none().text_color(t.foreground)))),
    ]);
    const repair = target?.booted && target.platform === "ios" && [
      div().h(1).mx(4).my(4).bg(t.border),
      h_flex().id("sim-repair-input").mx(4).px(8).py(6).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((el) => el.bg(t.hover))
        .tooltip("For when taps do nothing: repairs Device Hub input, then restarts serve-sim")
        .on_click((_e, cx) => { this.repairInput(target); cx.notify(); })
        .child(div().flex_1().truncate().text_size(13).text_color(t.foreground).child("Repair input"))
        .child(div().text_size(11).text_color(t.dim).child("restarts SpringBoard")),
    ];
    return v_flex().id("simulator-menu").absolute().top(HEADER + PAD - 4).left(PAD).right(PAD).pb(4)
      .rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(rows.length ? rows : [div().p(10).text_size(12).text_color(t.dim).child("No simulators or emulators. Create one in Xcode or Android Studio.")])
      .when(repair, (el) => el.children(repair));
  }

  toolbar(t) {
    const live = this.phase.kind === "live";
    return h_flex().h(TOOLBAR).flex_none().items_center().justify_end().gap(2)
      .children(BUTTONS.filter((b) => !b.only || b.only === this.phase.device?.platform).map((b) => this.tool(t, b.id, b.icon, b.tip, live, (cx) => {
        const input = this.session?.input;
        if (input) cx.spawn(() => b.press(input));
      })));
  }

  tool(t, id, icon, tip, enabled, action) {
    return h_flex().id(`tool-${id}`).size(TOOLBAR - 2).flex_none().items_center().justify_center().rounded(6)
      .text_color(enabled ? t.muted : t.dim).tooltip(tip)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => action(cx)))
      .when(!enabled, (el) => el.opacity(0.5))
      .child(svg(`${ICONS}/${icon}.svg`).size(14));
  }

  // Press, drag and release are one finger, as in Maestro's device view.
  screen(w, h, radius) {
    return div().id("screen").relative().w(w).h(h)
      .children(this.stack.map((i) => image(this.frames[i]).absolute().top(0).left(0).w(w).h(h).rounded(radius)))
      .on_mouse_down("left", (e) => {
        this.focus.focus();
        const p = fraction(e);
        const input = this.session?.input;
        if (!p || !input) return;
        this.touch = { ...p, edge: touchEdge(p) };
        input.touch("begin", p, this.touch.edge);
      })
      .on_mouse_move((e) => {
        const p = fraction(e);
        if (!this.touch || !p) return;
        Object.assign(this.touch, p);
        this.session?.input.touch("move", p, this.touch.edge);
      })
      .on_mouse_up("left", (e) => this.lift(fraction(e)))
      .on_hover((hovered) => { if (!hovered) this.lift(null); })
      .on_scroll_wheel((e) => {
        const p = fraction(e);
        const input = this.session?.input;
        if (!p || !input) return;
        const d = e.delta_lines ? { x: e.delta_lines.x * LINE, y: e.delta_lines.y * LINE } : e.delta;
        input.scroll(-d.x / e.bounds.width, -d.y / e.bounds.height, p);
      });
  }

  render() {
    const t = theme();
    const note = this.note();
    const maxH = this.size.height - HEADER - TOOLBAR - 4 * PAD - 2 * BEZEL - 2;
    const maxW = this.size.width - 2 * PAD - 2 * BEZEL - 2;
    const screenH = Math.max(120, Math.min(maxH, maxW / this.aspect));
    const screenW = Math.round(screenH * this.aspect);
    const radius = Math.round(screenW * 0.13);

    const screen = note == null
      ? this.screen(screenW, screenH, radius)
      : v_flex().w(screenW).h(screenH).rounded(radius).bg("#000000").items_center().justify_center().p(24)
          .child(div().text_size(12).text_color(t.dim).child(note));

    return v_flex().id("herdr-sim").relative().size_full().p(PAD).gap(PAD)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.keyDown(e, cx))
      .on_key_up((e, cx) => this.keyUp(e, cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(this.selector(t))
      .child(this.toolbar(t))
      .child(v_flex().flex_1().items_center().justify_center()
        .child(div().p(BEZEL).rounded(radius + BEZEL).bg("#1c1c1e").border(1).border_color("#3a3a3c").child(screen)))
      .when(this.picking, (el) => el.child(this.menu(t)));
  }
}
