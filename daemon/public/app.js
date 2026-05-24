const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");

const els = {
  status:      $("status"),
  sessionName: $("session-name"),
  name:        $("name"),
  body:        $("body"),
  sendBtn:     $("send-btn"),
  feed:        $("feed-list"),
};

let ws = null;
let mySpeaker = localStorage.getItem("team-claude.speaker") || crypto.randomUUID();
localStorage.setItem("team-claude.speaker", mySpeaker);

const savedName = localStorage.getItem("team-claude.name") || "";
els.name.value = savedName;
els.name.addEventListener("input", () => localStorage.setItem("team-claude.name", els.name.value));

function setOnline(online) {
  els.status.textContent = online ? "online" : "offline";
  els.status.classList.toggle("status-online", online);
  els.status.classList.toggle("status-offline", !online);
  els.sendBtn.disabled = !online;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatTime(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function appendEvent(ev) {
  const placeholder = els.feed.querySelector(".muted");
  if (placeholder) placeholder.remove();
  if (!ev.body) return;
  const li = document.createElement("li");
  li.innerHTML = `<div class="meta"><strong>${escapeHtml(ev.name || ev.speaker)}</strong>
    <span class="muted">· ${formatTime(ev.ts)}</span></div>
    <div class="body">${escapeHtml(ev.body)}</div>`;
  els.feed.prepend(li);
  while (els.feed.children.length > 30) els.feed.lastChild.remove();
}

function renderSnapshot(snap) {
  if (!snap) return;
  const count = snap.participants?.length ?? 0;
  els.sessionName.textContent = `session: ${snap.session} · ${count} participant(s)`;
}

function connect() {
  if (!TOKEN) {
    els.sessionName.textContent = "manque ?token=… dans l'URL";
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.addEventListener("open", () => setOnline(true));
  ws.addEventListener("close", () => { setOnline(false); setTimeout(connect, 2000); });
  ws.addEventListener("error", () => setOnline(false));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.kind === "hello" || msg.kind === "event") {
      renderSnapshot(msg.state || msg.snapshot);
      if (msg.ev) appendEvent(msg.ev);
    } else if (msg.kind === "error") {
      console.warn("daemon error:", msg.message);
    }
  });
}

function sendMessage() {
  const body = els.body.value.trim();
  if (!body) { els.body.focus(); return; }
  const name = els.name.value.trim();
  if (!name)  { els.name.focus(); return; }
  ws?.send(JSON.stringify({ speaker: mySpeaker, name, body }));
  els.body.value = "";
  els.body.focus();
}

els.sendBtn.addEventListener("click", sendMessage);
els.body.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});

connect();
