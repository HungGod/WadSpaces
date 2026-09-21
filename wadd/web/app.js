"use strict";

const $ = (id) => document.getElementById(id);
const BUSY = new Set(["pulling", "starting", "waiting", "stopping"]);
let snapshot = null;

function tick() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function statusText(ws) {
  const s = ws.state;
  if (s.phase === "ready") return "Running";
  if (s.phase === "error") return "Error: " + (s.error || "failed");
  if (BUSY.has(s.phase)) return s.phase[0].toUpperCase() + s.phase.slice(1) + "…";
  if (s.container === "running") return "Running";
  return "Stopped";
}

function dotClass(ws) {
  const p = ws.state.phase;
  if (p === "ready" || ws.state.container === "running") return "ready";
  if (p === "error") return "error";
  if (BUSY.has(p)) return "busy";
  return "";
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function tile(ws) {
  const b = el("button", "tile");
  b.type = "button";
  b.dataset.id = ws.id;
  const art = el("div", "art");
  if (ws.icon) art.style.backgroundImage = `url("${ws.icon}")`;
  else art.textContent = ws.name.slice(0, 1);
  const meta = el("div", "meta");
  meta.append(el("div", "name", ws.name));
  if (ws.hotkey) meta.append(el("span", "key", "Super " + ws.hotkey));
  const status = el("div", "status");
  status.append(el("span", "dot " + dotClass(ws)), el("span", null, statusText(ws)));
  b.append(art, meta, status);
  b.addEventListener("click", () => switchTo(ws));
  b.setAttribute("aria-label", `${ws.name}, ${statusText(ws)}`);
  return b;
}

function creatorTile(url) {
  const b = el("button", "tile creator");
  b.type = "button";
  const art = el("div", "art", "WAD CREATOR");
  const meta = el("div", "meta");
  meta.append(el("div", "name", "Wad Creator"));
  const status = el("div", "status");
  status.append(el("span", null, "Build and manage workspaces"));
  b.append(art, meta, status);
  b.addEventListener("click", async () => {
    try { await post("/api/navigate", { url }); } catch (_) { /* fall through */ }
    if (!snapshot || !snapshot.kiosk_connected) location.href = url;
  });
  return b;
}

function render(s) {
  snapshot = s;
  const focused = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.id : null;
  const grid = $("grid");
  grid.replaceChildren(...s.workspaces.map(tile), creatorTile(s.wadcreator_url));
  if (focused) {
    const again = grid.querySelector(`[data-id="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }
  const bits = [];
  if (!s.backend_connected) bits.push("podman unreachable");
  if (!s.hotkey_devices && s.backend === "systemd") bits.push("hotkeys unavailable");
  $("notice").textContent = bits.join(" · ");
  $("notice").className = bits.length ? "warn" : "";
  $("machine").replaceChildren(el("b", null, s.machine), document.createTextNode(
    s.enrolled ? " · linked to Wad Creator" : ""));
  $("enroll-open").hidden = !s.cloud_enabled || s.enrolled;
}

// wadd moves the kiosk itself. Without a kiosk attached (dev), follow along here.
async function switchTo(ws) {
  const res = await post(`/api/workspaces/${ws.id}/switch`);
  if (snapshot && !snapshot.kiosk_connected) {
    location.href = res.workspace.state.phase === "ready" ? res.workspace.url : `/starting/${ws.id}`;
  }
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

function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => render(JSON.parse(e.data)));
  es.onerror = () => {
    es.close();
    setTimeout(connect, 2000);
  };
}

// Number keys on the launcher itself switch without Super; arrows move focus.
document.addEventListener("keydown", (e) => {
  if ($("enroll").open || !snapshot) return;
  if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey) {
    const ws = snapshot.workspaces.find((w) => String(w.hotkey) === e.key);
    if (ws) switchTo(ws);
    return;
  }
  const tiles = [...document.querySelectorAll(".tile")];
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
setInterval(tick, 10000);
fetch("/api/workspaces").then(() => connect());
