const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TOKEN = params.get("token");

const els = {
  status:        $("status"),
  sessionName:   $("session-name"),
  name:          $("name"),
  body:          $("body"),
  sendBtn:       $("send-btn"),
  feed:          $("feed-list"),
  stream:        $("stream-list"),
  thinking:      $("thinking"),
  thinkingVerb:  document.querySelector(".thinking-verb"),
  thinkingDots:  document.querySelector(".thinking-dots"),
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

// -------------------------------------------------------------- Claude stream

const THINKING_VERBS = [
  "Réfléchit", "Cogite", "Médite", "Élucubre", "Mijote",
  "Lit", "Cherche", "Pèse", "Compose", "Tricote",
];
let thinkingTimer = null;
let dotsTimer = null;

function showThinking(on) {
  if (on) {
    els.thinking.classList.remove("hidden");
    rotateVerb();
    animateDots();
    if (!thinkingTimer) thinkingTimer = setInterval(rotateVerb, 2500);
    if (!dotsTimer)     dotsTimer     = setInterval(animateDots, 400);
  } else {
    els.thinking.classList.add("hidden");
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    if (dotsTimer)     { clearInterval(dotsTimer);     dotsTimer = null; }
  }
}
function rotateVerb() {
  els.thinkingVerb.textContent = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}
function animateDots() {
  const cur = els.thinkingDots.textContent;
  els.thinkingDots.textContent = cur.length >= 3 ? "" : cur + ".";
}

function clearStreamPlaceholder() {
  const ph = els.stream.querySelector(".muted");
  if (ph) ph.remove();
}

function appendStreamEntry(entry) {
  clearStreamPlaceholder();
  const li = document.createElement("li");
  if (entry.role === "user") {
    li.className = "user";
    li.innerHTML = `<div class="meta">${formatTime(entry.ts)} · host</div>
      <div class="body">${escapeHtml(entry.text)}</div>`;
  } else if (entry.role === "assistant" && entry.text) {
    li.className = "assistant";
    li.innerHTML = `<div class="meta">${formatTime(entry.ts)} · Claude</div>
      <div class="body">${escapeHtml(entry.text)}</div>`;
  } else if (entry.role === "assistant" && entry.tool) {
    li.className = "tool";
    li.innerHTML = `<div class="body"><span class="tool-name">🔧 ${escapeHtml(entry.tool)}</span>${entry.summary ? " " + escapeHtml(entry.summary) : ""}</div>`;
  } else {
    return;
  }
  const atBottom = els.stream.scrollTop + els.stream.clientHeight >= els.stream.scrollHeight - 20;
  els.stream.appendChild(li);
  while (els.stream.children.length > 200) els.stream.firstChild.remove();
  if (atBottom) els.stream.scrollTop = els.stream.scrollHeight;
}

function applyBacklog(backlog) {
  els.stream.innerHTML = "";
  if (!backlog?.length) {
    els.stream.innerHTML = '<li class="muted">(en attente d\'une réponse de Claude…)</li>';
    return;
  }
  for (const e of backlog) appendStreamEntry(e);
  els.stream.scrollTop = els.stream.scrollHeight;
}

// ---------------------------------------------------------- Participant feed

function appendParticipantEvent(ev) {
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

// ----------------------------------------------------------------- WebSocket

function connect() {
  if (!TOKEN) {
    els.sessionName.textContent = "manque ?token=… dans l'URL";
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.addEventListener("open",  () => setOnline(true));
  ws.addEventListener("close", () => { setOnline(false); setTimeout(connect, 2000); });
  ws.addEventListener("error", () => setOnline(false));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    switch (msg.kind) {
      case "hello":
        renderSnapshot(msg.state);
        applyBacklog(msg.claudeBacklog);
        showThinking(msg.claudeStatus?.state === "thinking");
        break;
      case "event":
        renderSnapshot(msg.snapshot);
        if (msg.ev) appendParticipantEvent(msg.ev);
        break;
      case "claude-event":
        if (msg.entry) appendStreamEntry(msg.entry);
        break;
      case "claude-status":
        showThinking(msg.status?.state === "thinking");
        break;
      case "error":
        console.warn("daemon error:", msg.message);
        break;
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
