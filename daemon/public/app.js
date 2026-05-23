const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");

const els = {
  status:      $("status"),
  sessionName: $("session-name"),
  name:        $("name"),
  role:        $("role"),
  hasMore:     $("hasMore"),
  presenceBtn: $("presence-btn"),
  kind:        $("kind"),
  body:        $("body"),
  sendBtn:     $("send-btn"),
  participants: $("participants-list"),
  feed:        $("feed-list"),
};

let ws = null;
let mySpeaker = localStorage.getItem("team-claude.speaker") || crypto.randomUUID();
localStorage.setItem("team-claude.speaker", mySpeaker);

const saved = JSON.parse(localStorage.getItem("team-claude.me") || "{}");
els.name.value = saved.name || "";
els.role.value = saved.role || "";
els.hasMore.checked = saved.hasMore ?? true;

function setOnline(online) {
  els.status.textContent = online ? "online" : "offline";
  els.status.classList.toggle("status-online", online);
  els.status.classList.toggle("status-offline", !online);
  els.presenceBtn.disabled = !online;
  els.sendBtn.disabled = !online;
}

function persistMe() {
  localStorage.setItem("team-claude.me", JSON.stringify({
    name: els.name.value, role: els.role.value, hasMore: els.hasMore.checked,
  }));
}
[els.name, els.role].forEach(i => i.addEventListener("input", persistMe));
els.hasMore.addEventListener("change", persistMe);

function renderParticipants(participants) {
  if (!participants.length) {
    els.participants.innerHTML = '<li class="muted">(aucun)</li>';
    return;
  }
  els.participants.innerHTML = participants
    .map(p => `<li>
      <span class="dot ${p.hasMoreArguments ? "dot-active" : "dot-done"}"></span>
      <strong>${escapeHtml(p.name)}</strong>
      ${p.role ? `<span class="muted">/ ${escapeHtml(p.role)}</span>` : ""}
      <span class="muted">— ${p.hasMoreArguments ? "encore des arguments" : "a fini"}</span>
    </li>`).join("");
}

function appendEvent(ev) {
  const placeholder = els.feed.querySelector(".muted");
  if (placeholder) placeholder.remove();
  if (!["argument","objection","question","constraint","agreement","clarification"].includes(ev.kind)) return;
  const li = document.createElement("li");
  li.innerHTML = `<div class="meta"><strong>${escapeHtml(ev.name || ev.speaker)}</strong>
    ${ev.role ? `<span>/ ${escapeHtml(ev.role)}</span>` : ""}
    <span>/ ${ev.kind}</span></div>
    <div class="body">${escapeHtml(ev.body)}</div>`;
  els.feed.prepend(li);
  while (els.feed.children.length > 30) els.feed.lastChild.remove();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
      const snap = msg.state || msg.snapshot;
      if (snap) {
        els.sessionName.textContent = `session: ${snap.session}`;
        renderParticipants(snap.participants);
      }
      if (msg.ev) appendEvent(msg.ev);
    } else if (msg.kind === "error") {
      console.warn("daemon error:", msg.message);
    }
  });
}

els.presenceBtn.addEventListener("click", () => {
  if (!els.name.value.trim()) { els.name.focus(); return; }
  ws?.send(JSON.stringify({
    speaker: mySpeaker, name: els.name.value, role: els.role.value,
    kind: "presence", hasMoreArguments: els.hasMore.checked,
  }));
});

els.hasMore.addEventListener("change", () => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    speaker: mySpeaker, name: els.name.value, role: els.role.value,
    kind: "status", hasMoreArguments: els.hasMore.checked,
  }));
});

els.sendBtn.addEventListener("click", () => {
  const body = els.body.value.trim();
  if (!body) { els.body.focus(); return; }
  if (!els.name.value.trim()) { els.name.focus(); return; }
  ws?.send(JSON.stringify({
    speaker: mySpeaker, name: els.name.value, role: els.role.value,
    kind: els.kind.value, body,
    hasMoreArguments: els.hasMore.checked,
  }));
  els.body.value = "";
});

connect();
