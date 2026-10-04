const api = window.wadbrowser;
const listEl = document.getElementById("downloadsList");
const btnClose = document.getElementById("btnClose");

function humanBytes(n) {
  const num = Number(n || 0);
  if (!num) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = num;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

api.on("downloads:state", (data) => {
  const list = (data && data.downloads) || [];
  listEl.innerHTML = "";
  for (const d of list) {
    const row = document.createElement("div");
    row.className = "dlRow";

    const name = document.createElement("div");
    name.className = "dlName";
    name.textContent = d.filename || "Download";

    const meta = document.createElement("div");
    meta.className = "dlMeta";

    const left = document.createElement("div");
    const total = d.totalBytes > 0 ? ` / ${humanBytes(d.totalBytes)}` : "";
    left.textContent = `${humanBytes(d.receivedBytes)}${total} • ${d.state}`;

    const actions = document.createElement("div");
    actions.className = "dlActions";

    const open = document.createElement("button");
    open.textContent = "Show";
    open.addEventListener("click", () => api.send("downloads:openFolder", { path: d.path }));

    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", () => api.send("downloads:remove", { id: d.id }));

    actions.appendChild(open);
    if (d.state === "progressing" || d.state === "paused") {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => api.send("downloads:cancel", { id: d.id }));
      actions.appendChild(cancel);
    }
    actions.appendChild(remove);

    meta.appendChild(left);
    meta.appendChild(actions);

    row.appendChild(name);
    row.appendChild(meta);
    listEl.appendChild(row);
  }
});

btnClose.addEventListener("click", () => api.send("ui:downloadsPanelClose"));
