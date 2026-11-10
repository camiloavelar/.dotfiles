import { exec } from "herdr";
import { WebSocket } from "websocket";

// Run through an interactive login shell so npx resolves the same node the
// person's terminals do; the login-only PATH can point at a different one.
// On Xcode 27 serve-sim types through a Device Hub bridge that drops keys
// unless Device Hub is the frontmost app; without it, keys take the same
// path as touches.
const SERVE_SIM = "SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD=1 exec \"${SHELL:-/bin/zsh}\" -lic 'npx --yes serve-sim@0.1.49 \"$@\"' serve-sim \"$@\"";

// The helper's /ws input protocol: one tag byte, then a JSON body.
const TAG = { touch: 0x03, button: 0x04, key: 0x06, rotate: 0x07, scroll: 0x0b, keyboard: 0x0c };
// Simulator.app's Rotate Left order.
const ROTATE = {
  portrait: "landscape_left",
  landscape_left: "portrait_upside_down",
  portrait_upside_down: "landscape_right",
  landscape_right: "portrait",
};
// A touch that starts in the bottom 7% is tagged as the home-indicator edge,
// so iOS reads a swipe up from there as going home (serve-sim's own band).
const HOME_BAND = 0.93;
const EDGE_BOTTOM = 3;
export const touchEdge = (p) => (p.y >= HOME_BAND ? EDGE_BOTTOM : 0);

// gpui key names -> USB HID keyboard usages, as Maestro maps KeyboardEvent.code.
const USAGES = {
  enter: 40, escape: 41, backspace: 42, tab: 43, space: 44,
  "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56,
  home: 74, pageup: 75, delete: 76, end: 77, pagedown: 78, right: 79, left: 80, down: 81, up: 82,
};
for (let i = 0; i < 26; i++) USAGES[String.fromCharCode(97 + i)] = 4 + i;
for (let i = 0; i < 10; i++) USAGES["1234567890"[i]] = 30 + i;
for (let i = 1; i <= 12; i++) USAGES[`f${i}`] = 57 + i;
// A shifted symbol is its unshifted key with Shift held.
const UNSHIFTED = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
const MODIFIERS = [["control", 224], ["shift", 225], ["alt", 226]];

export async function serveSim(args) {
  const r = await exec("sh", ["-c", SERVE_SIM, "sh", ...args]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "serve-sim failed");
  return r.stdout.trim().split("\n").findLast((line) => line.startsWith("{")) ?? "{}";
}

export async function startHelper(device) {
  // `--list` reports every running helper whatever udid it gets, as one
  // object or as `streams`, so find this device's ourselves.
  const listed = JSON.parse(await serveSim(["--list", "-q", device.id]));
  const running = listed.running ? (listed.streams ?? [listed]).find((s) => s.device === device.id) : null;
  const helper = running ?? JSON.parse(await serveSim(["--detach", "-q", device.id]));
  const url = new URL(helper.streamUrl);
  const base = helper.streamUrl.replace(/\/stream\.mjpeg$/, "");
  return { device, host: url.hostname, port: Number(url.port), path: url.pathname, base, owned: !running, input: new Input(base) };
}

// HID usages for a gpui key event: null for keys the device has no use for
// and for cmd chords, which stay Herdr's.
export function keyUsages(event) {
  if (event.modifiers.platform) return null;
  let key = event.key;
  let shift = event.modifiers.shift;
  if (UNSHIFTED[key]) [key, shift] = [UNSHIFTED[key], true];
  if (/^[A-Z]$/.test(key)) [key, shift] = [key.toLowerCase(), true];
  const usage = USAGES[key];
  if (!usage) return null;
  const held = { ...event.modifiers, shift };
  return { usage, modifiers: MODIFIERS.filter(([name]) => held[name]).map(([, usage]) => usage) };
}

// No TextEncoder here; every body is ASCII (numbers and fixed names).
function frame(tag, body) {
  const json = body === undefined ? "" : JSON.stringify(body);
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = tag;
  for (let i = 0; i < json.length; i++) bytes[i + 1] = json.charCodeAt(i);
  return bytes;
}

// One /ws connection per helper. Points are normalized 0..1 of the screen.
export class Input {
  constructor(base) {
    this.base = base;
    this.socket = null;
    this.closed = false;
    this.queue = Promise.resolve();
    this.send(null);
  }

  // Writes go out one at a time, in order; a dropped socket reconnects once.
  // Input is fire-and-forget, so a failure is logged rather than thrown.
  send(tag, body) {
    this.queue = this.queue
      .then(() => this.write(tag == null ? null : frame(tag, body), true))
      .catch((e) => console.log(`serve-sim input: ${e.message ?? e}`));
    return this.queue;
  }

  async write(bytes, retry) {
    if (this.closed) return;
    try {
      if (!this.socket) {
        const socket = await WebSocket.connect(`${this.base.replace(/^http/, "ws")}/ws`);
        if (this.closed) return void socket.close();
        this.socket = socket;
      }
      if (bytes) await this.socket.write(bytes);
    } catch (e) {
      this.socket = null;
      if (!retry) throw e;
      await this.write(bytes, false);
    }
  }

  close() {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  // A gesture keeps the edge its first touch had.
  touch(type, p, edge = 0) {
    return this.send(TAG.touch, edge ? { type, x: p.x, y: p.y, edge } : { type, x: p.x, y: p.y });
  }

  button(button) {
    return this.send(TAG.button, { button });
  }

  hid(page, usage) {
    return this.send(TAG.button, { button: "hid", page, usage, phase: "press" });
  }

  key(type, usage) {
    return this.send(TAG.key, { type, usage });
  }

  // dx, dy: a fraction of the screen; positive scrolls toward what is below / right.
  scroll(dx, dy, p) {
    return this.send(TAG.scroll, { dx, dy, x: p.x, y: p.y });
  }

  softwareKeyboard() {
    return this.send(TAG.keyboard);
  }

  async rotate() {
    const config = await (await fetch(`${this.base}/config`)).json();
    return this.send(TAG.rotate, { orientation: ROTATE[config.orientation] ?? "portrait" });
  }
}
