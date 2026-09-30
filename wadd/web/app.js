"use strict";
// The shell: the one page the kiosk browser ever shows. It keeps a frame per
// live streamed workspace (so switching is instant), follows wadd's view over
// SSE, and draws the Super+Tab carousel, the Wi-Fi menu and the power menu on
// top. Native workspaces (display: host) are their own windows on the screen;
// wadd brings them forward, so here they only get a placeholder.
//
// Home is a short flow: pick workspaces -> how long (or skip focus) -> the
// landing page, "What others are working on". The picks download and start in
// the background and are one Super+Tab away. During focus time wadd keeps
// Home out of reach.

const $ = (id) => document.getElementById(id);
const BUSY = new Set(["pulling", "starting", "waiting", "stopping"]);
let snapshot = null;
let currentView = null;
const frames = new Map();   // view -> { el, src }
const frameOrder = [];      // most recently shown first
const lastPhase = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function tick() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

// ------------------------------------------------------------------ frames
function srcFor(view) {
  if (view.startsWith("app:")) return null;  // its own window, not a frame
  if (view.startsWith("url:")) return view.slice(4);
  const ws = wsFor(view);
  return ws && ws.display !== "host" ? ws.url : null;
}

function wsFor(view) {
  if (!snapshot || !view || !view.startsWith("workspace:")) return null;
  const id = view.slice("workspace:".length);
  return snapshot.workspaces.find((w) => w.id === id) || null;
}

function ensureFrame(view) {
  let f = frames.get(view);
  if (!f) {
    const src = srcFor(view);
    if (!src) return null;
    const iframe = document.createElement("iframe");
    iframe.className = "frame";
    iframe.src = src;
    iframe.setAttribute("allow", "autoplay; clipboard-read; clipboard-write; fullscreen");
    iframe.title = (wsFor(view) || {}).name || "Wad Creator";
    $("frames").append(iframe);
    f = { el: iframe, src };
    frames.set(view, f);
  }
  frameOrder.unshift(view);
  for (let i = frameOrder.lastIndexOf(view); i > 0; i--) {
    if (frameOrder[i] === view) frameOrder.splice(i, 1);
  }
  evictFrames();
  return f;
}

// Hidden frames keep streaming, so only the most recent few stay loaded.
function evictFrames() {
  const limit = Math.max(1, (snapshot && snapshot.live_frames) || 3);
  while (frameOrder.length > limit) {
    const view = frameOrder.pop();
    if (view === currentView) { frameOrder.unshift(view); break; }
    const f = frames.get(view);
    if (f) { f.el.remove(); frames.delete(view); }
  }
}

function applyView(view) {
  const home = view === "launcher" || !view;
  if (!home) ensureFrame(view);
  for (const [v, f] of frames) f.el.classList.toggle("on", v === view);
  $("home").classList.toggle("on", home);
  document.body.classList.toggle("home", home);
  currentView = view;
  renderNative();
  const f = frames.get(view);
  if (home) {
    const first = document.querySelector(".step:not([hidden]) .tile, .step:not([hidden]) .btn.primary");
    if (first && !$("wifi").open && !$("power").open) first.focus();
  } else if (f) {
    try { f.el.contentWindow.focus(); } catch (_) { f.el.focus(); }
  }
}

// What the shell shows for a native workspace: normally nothing, because its
// own window is on top; this is visible while it starts or has no window.
function renderNative() {
  if (currentView && currentView.startsWith("app:")) {
    $("native").hidden = false;
    $("native-art").style.backgroundImage = "";
    $("native-art").textContent = "W";
    $("native-text").textContent = "Opening Wad Creator…";
    return;
  }
  const ws = wsFor(currentView);
  const native = ws && ws.display === "host";
  $("native").hidden = !native;
  if (!native) return;
  const art = $("native-art");
  art.style.backgroundImage = ws.icon ? `url("${ws.icon}")` : "";
  art.textContent = ws.icon ? "" : ws.name.slice(0, 1);
  const st = ws.state;
  let text;
  if (snapshot && !snapshot.native_display) text = `${ws.name} draws on this machine's own screen, which needs the WadSpaces sway session.`;
  else if (st.phase === "error") text = `${ws.name}: ${st.error || "failed"}`;
  else if (st.phase === "ready") text = `${ws.name} is open.`;
  else text = `Starting ${ws.name}…`;
  $("native-text").textContent = text;
}

// A workspace that was restarted serves a new stream: reload its frame.
function reloadIfRestarted(ws) {
  const view = `workspace:${ws.id}`;
  const was = lastPhase.get(ws.id);
  lastPhase.set(ws.id, ws.state.phase);
  const f = frames.get(view);
  if (f && was && was !== "ready" && ws.state.phase === "ready") f.el.src = f.src;
  if (f && ws.state.container !== "running" && ws.state.phase !== "ready") {
    f.el.remove();
    frames.delete(view);
    const i = frameOrder.indexOf(view);
    if (i >= 0) frameOrder.splice(i, 1);
  }
}

// -------------------------------------------------------------- home tiles
function statusText(ws) {
  const s = ws.state;
  if (s.phase === "ready") return "Running";
  if (s.phase === "error") return "Error: " + (s.error || "failed");
  if (s.phase === "pulling" && s.message) return s.message;
  if (BUSY.has(s.phase)) return (s.message || s.phase) + "…";
  if (s.container === "running") return "Running";
  return s.image_present === false ? "Not downloaded" : "Stopped";
}

function dotClass(ws) {
  const p = ws.state.phase;
  if (p === "ready" || ws.state.container === "running") return "ready";
  if (p === "error") return "error";
  if (BUSY.has(p)) return "busy";
  return "";
}

// A download bar: real percentage when wadd knows the sizes, otherwise sliding.
function progressBar(ws) {
  const bar = el("div", "pbar");
  const fill = el("i");
  bar.append(fill);
  bar.setAttribute("role", "progressbar");
  if (ws.state.progress == null) {
    bar.classList.add("indeterminate");
  } else {
    fill.style.width = ws.state.progress + "%";
    bar.setAttribute("aria-valuenow", String(ws.state.progress));
  }
  return bar;
}

// A workspace tile on the pick step: a click toggles it (the order picked is
// the order they appear in Super+Tab).
function tile(ws) {
  const b = el("button", "tile");
  b.type = "button";
  b.dataset.id = ws.id;
  const at = flow.picked.indexOf(ws.id);
  b.setAttribute("aria-pressed", String(at >= 0));
  if (at >= 0) {
    b.classList.add("picked");
    b.append(el("span", "pick-no", String(at + 1)));
  }
  const art = el("div", "art");
  if (ws.icon) art.style.backgroundImage = `url("${ws.icon}")`;
  else art.textContent = ws.name.slice(0, 1);
  const meta = el("div", "meta");
  meta.append(el("div", "name", ws.name));
  if (ws.hotkey) meta.append(el("span", "key", "Super " + ws.hotkey));
  const status = el("div", "status");
  status.append(el("span", "dot " + dotClass(ws)), el("span", null, statusText(ws)));
  b.append(art, meta, status);
  if (ws.state.phase === "pulling") b.append(progressBar(ws));
  b.addEventListener("click", () => togglePick(ws));
  b.setAttribute("aria-label", `${ws.name}, ${statusText(ws)}`);
  return b;
}

// ---------------------------------------------------------------- the flow
// flow.step: pick -> time. Kept here (not in wadd) until Start or Skip, so a
// re-render from an SSE update never loses what was picked.
const flow = { step: "pick", picked: [], minutes: 50 };

function togglePick(ws) {
  const i = flow.picked.indexOf(ws.id);
  if (i >= 0) flow.picked.splice(i, 1); else flow.picked.push(ws.id);
  renderFlow();
}

function pickedWorkspaces() {
  if (!snapshot) return [];
  return flow.picked.map((id) => snapshot.workspaces.find((w) => w.id === id)).filter(Boolean);
}

function goStep(step) {
  flow.step = step;
  renderFlow();
  const first = document.querySelector(`#step-${step} .tile, #step-${step} .dial`);
  if (first) first.focus();
}

function online() {
  const n = (snapshot && snapshot.network) || {};
  return !n.available || n.connectivity === "full";
}

// Downloads start as soon as the picks are made and run while the time is
// chosen (wadd does one at a time). Images copied onto the drive are present
// already, so offline is fine unless one is missing.
function startDownloads() {
  if (!online()) return;
  for (const ws of pickedWorkspaces()) {
    if (ws.state.image_present === false && !BUSY.has(ws.state.phase)) {
      post(`/api/workspaces/${ws.id}/download`).catch((err) => toast(err.message));
    }
  }
}

// One line per pick that isn't ready yet, above the dial.
function dlRow(ws) {
  const row = el("div", "dl-row");
  const head = el("div", "dl-head");
  head.append(el("span", "dot " + dotClass(ws)), el("b", null, ws.name));
  const s = ws.state;
  let label;
  if (s.phase === "error") label = s.error || "failed";
  else if (s.phase === "pulling") label = s.message || "Downloading…";
  else if (s.image_present === false && !online()) label = "Not downloaded: connect to Wi-Fi";
  else label = "Waiting to download…";
  head.append(el("span", "dl-label" + (s.phase === "error" ? " err" : ""), label));
  row.append(head);
  if (s.phase === "pulling") row.append(progressBar(ws));
  return row;
}

function needsDownload(ws) {
  return ws.state.image_present === false || ws.state.phase === "pulling" || ws.state.phase === "error";
}

// Sample streams for the landing page, until sharing exists.
const SAMPLE_STREAMS = [
  { title: "Cosmic Bodybuilding, ch. 12", who: "Hung", desc: "Drafting the tournament arc in Obsidian.", hue: 265 },
  { title: "IntelligenceQuest", who: "Mele", desc: "C++ tile engine: collision layers and a level editor.", hue: 200 },
  { title: "Kale Browser", who: "Sione", desc: "Electron web-app packager; fixing tab restore.", hue: 140 },
  { title: "Vanua Academy site", who: "Ana", desc: "Firebase course pages and the enrolment flow.", hue: 30 },
  { title: "Kale Phone", who: "Tevita", desc: "Android build of the Kale apps, testing on the emulator.", hue: 330 },
  { title: "Pixel art pack", who: "Lusi", desc: "Sprites and a tileset in Piskel and Tiled.", hue: 90 },
];

function streamCard(st) {
  const card = el("article", "stream");
  const art = el("div", "art stream-art");
  art.style.setProperty("--h", st.hue);
  art.append(el("span", "live", "LIVE"), el("i", "win"), el("i", "win two"));
  const body = el("div", "stream-body");
  body.append(el("div", "name", st.title), el("div", "who", st.who), el("p", "desc", st.desc));
  card.append(art, body);
  return card;
}

// The landing page's top row: your picks (click to open), time left, and
// "New session" when you're free to start over.
function renderMine(s) {
  const session = s.session;
  const box = $("mine");
  const items = session.workspaces.map((id) => s.workspaces.find((w) => w.id === id)).filter(Boolean);
  // Each pick opens as soon as it is ready, while the others still download.
  const chips = items.map((w) => {
    const b = el("button", "chip ws-chip");
    b.type = "button";
    const pct = w.state.phase === "pulling" && w.state.progress != null ? ` ${w.state.progress}%` : "";
    b.append(el("span", "dot " + dotClass(w)), el("span", null, w.name + pct));
    b.title = statusText(w);
    b.addEventListener("click", () => switchTo(w));
    return b;
  });
  const label = el("span", "mine-label",
    session.mode === "free" ? "Your workspaces" :
    session.expired ? "Focus time is up · your workspaces" :
    session.ends_at == null ? `Focus · ${formatMinutes(session.minutes)}, starts when you open one` :
    `Focus · ${formatLeft(session)} left · your workspaces`);
  const parts = [label, ...chips];
  if (session.mode === "free" || session.expired) {
    const again = el("button", "link", "New session");
    again.type = "button";
    again.addEventListener("click", () => post("/api/session/end").catch((e) => toast(e.message)));
    parts.push(again);
  }
  box.replaceChildren(...parts);
}

function renderFlow() {
  const s = snapshot;
  if (!s) return;
  const session = s.session;
  const locked = session && session.mode !== "free" && !session.expired;
  // A session began (here or elsewhere): the flow starts over next time.
  if (session && flow.step !== "pick") { flow.step = "pick"; flow.picked = []; }
  for (const step of ["pick", "time", "landing"]) {
    $(`step-${step}`).hidden = session ? step !== "landing" : step !== flow.step;
  }
  $("creator-open").hidden = !!locked;
  if (session) {
    renderMine(s);
    if (!$("streams").children.length) $("streams").replaceChildren(...SAMPLE_STREAMS.map(streamCard));
    return;
  }
  flow.picked = flow.picked.filter((id) => s.workspaces.some((w) => w.id === id));
  if (flow.step === "pick") {
    const focused = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.id : null;
    $("grid").replaceChildren(...s.workspaces.map(tile));
    if (focused && currentView === "launcher") {
      const again = $("grid").querySelector(`[data-id="${CSS.escape(focused)}"]`);
      if (again) again.focus();
    }
    $("pick-go").disabled = !flow.picked.length;
    $("pick-hint").textContent = flow.picked.length
      ? pickedWorkspaces().map((w) => w.name).join(", ")
      : "Pick one or more.";
  } else if (flow.step === "time") {
    $("dl-list").replaceChildren(...pickedWorkspaces().filter(needsDownload).map(dlRow));
    renderDial();
  }
}

$("pick-go").addEventListener("click", () => {
  if (!flow.picked.length) return;
  startDownloads();
  goStep("time");
});
$("time-back").addEventListener("click", () => goStep("pick"));

async function beginSession(minutes) {
  for (const id of ["time-go", "time-skip"]) $(id).disabled = true;
  try {
    await post("/api/session", minutes == null
      ? { workspaces: flow.picked }
      : { workspaces: flow.picked, minutes });
  } catch (err) {
    toast(err.message);
  } finally {
    for (const id of ["time-go", "time-skip"]) $(id).disabled = false;
  }
}
$("time-go").addEventListener("click", () => beginSession(flow.minutes));
$("time-skip").addEventListener("click", () => beginSession(null));
$("creator-open").addEventListener("click", () => {
  post("/api/apps/wadcreator/open").catch((e) => toast(e.message));
});

// ---------------------------------------------------------------- the dial
// Drag the hand round like a clock: one lap is an hour, and going past 12
// adds (or takes away) an hour, drawn as rings inside the dial.
const DIAL = { cx: 120, cy: 120, r: 96, min: 5, max: 720, step: 5 };
const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function polar(deg, r) {
  const a = (deg - 90) * Math.PI / 180;
  return [DIAL.cx + r * Math.cos(a), DIAL.cy + r * Math.sin(a)];
}

function formatMinutes(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  if (!h) return `${mm} min`;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

function renderDial() {
  const m = flow.minutes;
  const dial = $("dial");
  const hours = Math.floor(m / 60), mm = m % 60;
  const deg = (mm / 60) * 360;
  const parts = [svg("circle", { class: "dial-face", cx: DIAL.cx, cy: DIAL.cy, r: DIAL.r })];
  for (let t = 0; t < 60; t += 5) {
    const [x1, y1] = polar(t * 6, DIAL.r - (t % 15 ? 5 : 10));
    const [x2, y2] = polar(t * 6, DIAL.r);
    parts.push(svg("line", { class: "dial-tick", x1, y1, x2, y2 }));
  }
  for (let i = 0; i < Math.min(hours, 6); i++) {
    parts.push(svg("circle", { class: "dial-hour", cx: DIAL.cx, cy: DIAL.cy, r: DIAL.r - 18 - i * 7 }));
  }
  if (mm) {
    const [x, y] = polar(deg, DIAL.r);
    const large = deg > 180 ? 1 : 0;
    parts.push(svg("path", {
      class: "dial-arc",
      d: `M ${DIAL.cx} ${DIAL.cy - DIAL.r} A ${DIAL.r} ${DIAL.r} 0 ${large} 1 ${x} ${y}`,
    }));
  }
  const [hx, hy] = polar(deg, DIAL.r);
  parts.push(svg("line", { class: "dial-hand", x1: DIAL.cx, y1: DIAL.cy, x2: hx, y2: hy }));
  parts.push(svg("circle", { class: "dial-knob", cx: hx, cy: hy, r: 11 }));
  parts.push(svg("circle", { class: "dial-pin", cx: DIAL.cx, cy: DIAL.cy, r: 4 }));
  dial.replaceChildren(...parts);
  dial.setAttribute("aria-valuenow", String(m));
  dial.setAttribute("aria-valuetext", formatMinutes(m));
  $("dial-value").textContent = formatMinutes(m);
  const until = new Date(Date.now() + m * 60000);
  $("dial-until").textContent = "until " + until.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  for (const c of document.querySelectorAll(".chip")) c.classList.toggle("on", Number(c.dataset.min) === m);
}

function setMinutes(m) {
  flow.minutes = Math.max(DIAL.min, Math.min(DIAL.max, Math.round(m / DIAL.step) * DIAL.step));
  renderDial();
}

let dragging = false;
// A press puts the hand where you pressed (same hour); only dragging it past
// 12 changes the hour, so a tap near 12 can't add one by accident.
function dialPointer(e, drag) {
  const box = $("dial").getBoundingClientRect();
  const x = e.clientX - box.left - box.width / 2;
  const y = e.clientY - box.top - box.height / 2;
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
  let mm = Math.round(deg / 6 / DIAL.step) * DIAL.step % 60;
  let hours = Math.floor(flow.minutes / 60);
  const prev = flow.minutes % 60;
  if (drag && prev >= 45 && mm <= 15) hours++;              // clockwise past 12
  else if (drag && prev <= 15 && mm >= 45 && hours > 0) hours--; // back past 12
  else if (drag && prev <= 15 && mm >= 45) mm = prev;       // already at the start
  setMinutes(hours * 60 + mm);
}
$("dial").addEventListener("pointerdown", (e) => {
  dragging = true;
  $("dial").setPointerCapture(e.pointerId);
  dialPointer(e, false);
});
$("dial").addEventListener("pointermove", (e) => { if (dragging) dialPointer(e, true); });
$("dial").addEventListener("pointerup", () => { dragging = false; });
$("dial").addEventListener("keydown", (e) => {
  const d = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 60, PageDown: -60 }[e.key];
  if (d) { e.preventDefault(); setMinutes(flow.minutes + d); }
  if (e.key === "Enter") { e.preventDefault(); $("time-go").click(); }
});
for (const c of document.querySelectorAll(".chip")) {
  c.addEventListener("click", () => setMinutes(Number(c.dataset.min)));
}

// ------------------------------------------------------------ session chip
function formatLeft(session) {
  if (session.ends_at == null) return "";
  const left = Math.max(0, Math.round((session.ends_at * 1000 - Date.now()) / 1000));
  if (left >= 3600) return `${Math.floor(left / 3600)} h ${Math.floor(left % 3600 / 60)} min`;
  if (left >= 60) return `${Math.ceil(left / 60)} min`;
  return `${left} s`;
}

function renderTimer() {
  const session = snapshot && snapshot.session;
  const chip = $("timer");
  chip.hidden = !session || session.mode === "free";
  if (chip.hidden) return;
  chip.classList.toggle("done", session.expired);
  chip.textContent = session.expired ? "Time's up"
    : session.ends_at == null ? `Focus ${formatMinutes(session.minutes)}`
    : `${formatLeft(session)} left`;
  if (!$("step-landing").hidden) renderMine(snapshot);
}

function render(s) {
  snapshot = s;
  renderFlow();
  renderTimer();
  const bits = [];
  if (!s.backend_connected) bits.push("podman unreachable");
  if (!s.hotkey_devices && s.backend === "systemd") bits.push("keyboard not captured");
  $("notice").textContent = bits.join(" · ");
  $("notice").className = bits.length ? "warn" : "";
  $("machine").replaceChildren(el("b", null, s.machine), document.createTextNode(
    s.enrolled ? " · linked to Wad Creator" : ""));
  $("enroll-open").hidden = !s.cloud_enabled || s.enrolled;
  for (const ws of s.workspaces) reloadIfRestarted(ws);
  renderNet(s.network || {});
  // Under the kiosk's sway the floating HUD (hud) draws these above every
  // window; this in-page copy is for running the shell anywhere else.
  $("hud").hidden = !!s.native_display;
  renderPending(s);
  if (s.view !== currentView) applyView(s.view);
  else renderNative();
}

// A cold switch stays where it is and swaps when the workspace answers, so
// this toast is the only sign of it until then.
function renderPending(s) {
  const ws = s.pending ? s.workspaces.find((w) => w.id === s.pending) : null;
  if (!ws) { $("toast").hidden = true; return; }
  $("toast").hidden = false;
  $("toast-text").textContent = ws.state.phase === "error"
    ? `${ws.name}: ${ws.state.error || "failed"}`
    : `Starting ${ws.name}… ${ws.state.message || ""}`.trim();
  $("toast").classList.toggle("error", ws.state.phase === "error");
  const old = $("toast").querySelector(".pbar");
  if (old) old.remove();
  if (ws.state.phase === "pulling") $("toast-cancel").before(progressBar(ws));
}

function toast(text, error = true) {
  $("toast").hidden = false;
  $("toast").classList.toggle("error", error);
  $("toast").classList.toggle("info", !error);
  $("toast-text").textContent = text;
  $("toast-cancel").hidden = true;
  setTimeout(() => {
    if (!snapshot || !snapshot.pending) $("toast").hidden = true;
    $("toast-cancel").hidden = false;
  }, 6000);
}

$("toast-cancel").addEventListener("click", () => {
  const id = snapshot && snapshot.pending;
  if (id) post(`/api/workspaces/${id}/stop`).catch((e) => toast(e.message));
  $("toast").hidden = true;
});

async function switchTo(ws) {
  await post(`/api/workspaces/${ws.id}/switch`).catch((e) => toast(e.message));
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (_) { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}

// ---------------------------------------------------------------- carousel
function renderCarousel(c) {
  const box = $("carousel");
  if (!c.open) { box.hidden = true; return; }
  box.hidden = false;
  $("carousel-cards").replaceChildren(...c.items.map((item, i) => {
    const card = el("div", "card" + (i === c.index ? " sel" : "") + (item.running ? "" : " off"));
    const art = el("div", "art");
    if (item.icon) art.style.backgroundImage = `url("${item.icon}")`;
    else art.textContent = item.view === "launcher" ? "⌂" : item.name.slice(0, 1);
    card.append(art, el("div", "name", item.name));
    return card;
  }));
  const sel = $("carousel-cards").querySelector(".sel");
  if (sel) sel.scrollIntoView({ block: "nearest", inline: "center" });
}

// -------------------------------------------------------------------- wifi
const wifi = { list: [], selected: null, busy: false };

function bars(signal) {
  return signal == null ? 0 : Math.max(1, Math.min(4, Math.ceil(signal / 25)));
}

function renderNet(n) {
  const btn = $("net");
  btn.hidden = !n.available;
  if (!n.available) return;
  const online = n.connectivity === "full";
  btn.classList.toggle("offline", !online);
  $("net-bars").dataset.level = n.ssid ? bars(n.signal) : 0;
  $("net-label").textContent = n.ssid
    ? n.ssid + (online ? "" : " (no internet)")
    : (online ? "Wired" : "Not connected");
  btn.setAttribute("aria-label", `Network: ${$("net-label").textContent}. Open Wi-Fi settings`);
  // Wi-Fi is optional (images come on the drive), so it is never forced open.
}

function wifiMsg(text, error) {
  $("wifi-msg").textContent = text || "";
  $("wifi-msg").className = "msg" + (error ? " error" : "");
}

function renderWifiList() {
  const items = wifi.list.map((n) => {
    const b = el("button", "wifi-item" + (n.supported ? "" : " unsupported"));
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(wifi.selected === n.ssid));
    const sig = el("span", "bars");
    sig.dataset.level = bars(n.signal);
    sig.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 4; i++) sig.append(el("i"));
    const tags = [n.active ? "Connected" : n.known ? "Saved" : "", n.secure ? "🔒" : "Open"]
      .filter(Boolean).join(" · ");
    b.append(sig, el("span", "ssid", n.ssid), el("span", "tag", tags));
    b.addEventListener("click", () => selectWifi(n.ssid));
    return b;
  });
  $("wifi-list").replaceChildren(...items);
  if (!items.length) $("wifi-list").append(el("div", "msg", "No networks found."));
}

function selectWifi(ssid) {
  wifi.selected = ssid;
  const n = wifi.list.find((x) => x.ssid === ssid);
  renderWifiList();
  wifiMsg("");
  const needsPass = n && n.supported && n.secure && !n.known && !n.active;
  $("wifi-join").hidden = !needsPass;
  $("wifi-pass").value = "";
  $("wifi-connect").hidden = !n || !n.supported || n.active;
  $("wifi-disconnect").hidden = !n || !n.active;
  $("wifi-forget").hidden = !n || !n.known;
  if (n && !n.supported) wifiMsg(`${n.security} networks can't be joined from here.`, true);
  if (needsPass) $("wifi-pass").focus();
}

async function scanWifi() {
  wifiMsg("Scanning…");
  try {
    const r = await fetch("/api/network/wifi");
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    wifi.list = await r.json();
    wifiMsg("");
  } catch (err) {
    wifiMsg(err.message, true);
  }
  if (!wifi.list.some((n) => n.ssid === wifi.selected)) wifi.selected = null;
  renderWifiList();
  if (wifi.selected) selectWifi(wifi.selected);
}

function openWifi() {
  const n = (snapshot && snapshot.network) || {};
  $("wifi-status").textContent = n.ssid
    ? `Connected to ${n.ssid}` + (n.connectivity === "full" ? "." : " (no internet yet).")
    : "Choose a network to get this machine online.";
  wifi.selected = null;
  for (const id of ["wifi-join", "wifi-connect", "wifi-disconnect", "wifi-forget"]) $(id).hidden = true;
  if (!$("wifi").open) $("wifi").showModal();
  scanWifi();
}

async function wifiAction(path, body, doing) {
  if (wifi.busy) return;
  wifi.busy = true;
  wifiMsg(doing);
  try {
    await post(path, body);
    wifiMsg("");
    await scanWifi();
    const n = snapshot && snapshot.network;
    if (path.endsWith("/connect") && n && n.ssid === body.ssid) $("wifi").close();
  } catch (err) {
    wifiMsg(err.message, true);
  } finally {
    wifi.busy = false;
  }
}

$("net").addEventListener("click", openWifi);
$("wifi-rescan").addEventListener("click", scanWifi);
$("wifi-connect").addEventListener("click", () => {
  const n = wifi.list.find((x) => x.ssid === wifi.selected);
  if (!n) return;
  const password = $("wifi-join").hidden ? null : $("wifi-pass").value;
  if (!$("wifi-join").hidden && !password) { wifiMsg("Enter the password.", true); return; }
  wifiAction("/api/network/wifi/connect", { ssid: n.ssid, password }, `Connecting to ${n.ssid}…`);
});
$("wifi-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("wifi-connect").click(); }
});
$("wifi-disconnect").addEventListener("click", () =>
  wifiAction("/api/network/wifi/disconnect", null, "Disconnecting…"));
$("wifi-forget").addEventListener("click", () =>
  wifiAction("/api/network/wifi/forget", { ssid: wifi.selected }, "Forgetting…"));

// ------------------------------------------------------------------- power
$("power-open").addEventListener("click", () => {
  $("power-msg").textContent = "";
  $("power-msg").className = "msg";
  $("power").showModal();
});

async function power(action, doing) {
  $("power-msg").textContent = doing;
  $("power-msg").className = "msg";
  try {
    await post("/api/power", { action });
  } catch (err) {
    $("power-msg").textContent = err.message;
    $("power-msg").className = "msg error";
  }
}
$("power-off").addEventListener("click", () => power("poweroff", "Shutting down…"));
$("power-reboot").addEventListener("click", () => power("reboot", "Restarting…"));

// -------------------------------------------------------------------- init
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => render(JSON.parse(e.data)));
  es.addEventListener("carousel", (e) => renderCarousel(JSON.parse(e.data)));
  es.addEventListener("notice", (e) => toast(JSON.parse(e.data).text, false));
  // The floating HUD (over native windows) asks for a menu: wadd has brought
  // this page forward; hand the screen back when the menu closes.
  es.addEventListener("panel", (e) => {
    const { panel } = JSON.parse(e.data);
    const dialog = panel === "wifi" ? $("wifi") : $("power");
    if (panel === "wifi") openWifi(); else $("power-open").click();
    dialog.addEventListener("close", () => post("/api/hud/closed").catch(() => {}), { once: true });
  });
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

// On the pick step a bare number key toggles that workspace, Enter continues,
// and arrows move focus. Inside a workspace the frame has the keys; wadd's
// keyboard proxy handles Super there.
document.addEventListener("keydown", (e) => {
  if ($("enroll").open || $("wifi").open || $("power").open || !snapshot) return;
  if (currentView !== "launcher") return;
  const picking = !$("step-pick").hidden;
  if (picking && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
    const ws = snapshot.workspaces.find((w) => String(w.hotkey) === e.key);
    if (ws) togglePick(ws);
    return;
  }
  if (picking && e.key === "Enter" && document.activeElement?.classList.contains("tile") && flow.picked.length) {
    e.preventDefault();
    $("pick-go").click();
    return;
  }
  const tiles = [...document.querySelectorAll(".step:not([hidden]) .tile")];
  const i = tiles.indexOf(document.activeElement);
  const cols = Math.max(1, Math.round($("grid").clientWidth / (tiles[0]?.clientWidth || 1)));
  const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
  if (move) {
    e.preventDefault();
    const next = tiles[Math.min(tiles.length - 1, Math.max(0, i < 0 ? 0 : i + move))];
    if (next) next.focus();
  }
});

$("enroll-open").addEventListener("click", () => {
  $("enroll-msg").textContent = "";
  $("enroll-msg").className = "msg";
  $("enroll").showModal();
  $("enroll-code").focus();
});
$("enroll-go").addEventListener("click", async (e) => {
  e.preventDefault();
  const code = $("enroll-code").value.trim();
  if (!code) return;
  $("enroll-msg").textContent = "Linking…";
  try {
    await post("/api/enroll", { code });
    $("enroll").close();
  } catch (err) {
    $("enroll-msg").textContent = err.message;
    $("enroll-msg").className = "msg error";
  }
});

tick();
setInterval(() => { tick(); renderTimer(); if (flow.step === "time") renderDial(); }, 10000);
connect();
